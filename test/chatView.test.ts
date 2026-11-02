import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type * as vscode from "vscode";
import type { AgentManager } from "../src/agentManager";
import type { AgentUpdates } from "../src/agentUpdates";
import { ChatViewProvider } from "../src/chat/chatViewProvider";
import type { FromWebview, TabInfo } from "../src/chat/protocol";
import { makeRuntime } from "../src/runtime";
import { makeOutput } from "./helpers";
import { __test, commands, EventEmitter, Uri, window, workspace } from "./stubs/vscode";

const MOCK_AGENT = fileURLToPath(new URL("./fixtures/mock-agent.mjs", import.meta.url));

type Posted = Record<string, any>;

const memento = (values = new Map<string, unknown>()) =>
  ({
    get: (key: string, fallback?: unknown) => (values.has(key) ? values.get(key) : fallback),
    update: async (key: string, value: unknown) => void values.set(key, value),
    keys: () => [...values.keys()],
  }) as unknown as vscode.Memento;

/** Set per test: what the mock agent can do, and whether it is still installed. */
let agentEnv: Record<string, string> = {};
let installed = true;

const manager = {
  onDidChange: new EventEmitter<void>().event,
  agents: Effect.succeed([{ id: "mock", name: "Mock" }]),
  has: (id: string) => Effect.sync(() => installed && id === "mock"),
  command: () => Effect.sync(() => ({ command: process.execPath, args: [MOCK_AGENT], env: { ...process.env, MOCK_FORK: "1", ...agentEnv } })),
  activeId: Effect.succeed("mock"),
  setActive: () => Effect.void,
} as unknown as AgentManager["Service"];

const updates = {
  pending: Effect.succeed([]),
  onDidChange: new EventEmitter<void>().event,
} as unknown as AgentUpdates["Service"];

/** The chat view in a fake webview, on a real mock agent process, with the real services and a workspace in a temp folder. */
const openChat = Effect.acquireRelease(
  Effect.promise(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "code-acp-chat-"));
    const folder = path.join(root, "workspace");
    await fs.mkdir(folder);
    workspace.workspaceFolders = [{ name: "workspace", uri: Uri.file(folder) }];
    const context = {
      extensionUri: Uri.file(root),
      globalStorageUri: Uri.file(path.join(root, "global")),
      storageUri: Uri.file(path.join(root, "storage")),
      workspaceState: memento(),
      globalState: memento(),
      extension: { packageJSON: { version: "1.2.3" } },
      subscriptions: [],
    } as unknown as vscode.ExtensionContext;
    const runtime = makeRuntime(context, makeOutput());
    const posted: Posted[] = [];
    let receive: (message: FromWebview) => void = () => {};
    const view = {
      visible: true,
      webview: {
        options: {},
        html: "",
        cspSource: "test",
        asWebviewUri: (uri: Uri) => uri,
        postMessage: async (message: Posted) => {
          posted.push(message);
          return true;
        },
        onDidReceiveMessage: (listener: typeof receive) => {
          receive = listener;
        },
      },
      onDidChangeVisibility: () => {},
      onDidDispose: () => {},
      show: () => {},
    } as unknown as vscode.WebviewView;
    const provider = new ChatViewProvider(context, runtime, manager, updates);
    provider.resolveWebviewView(view);
    return { root, runtime, provider, posted, context, send: (message: FromWebview) => receive(message) };
  }),
  ({ root, runtime, provider }) =>
    Effect.promise(async () => {
      provider.dispose();
      // Lets what the last messages started finish: `git` asked for the branch, the tabs being saved.
      await new Promise((resolve) => setTimeout(resolve, 100));
      await runtime.dispose();
      await fs.rm(root, { recursive: true, force: true });
    }),
);

const until = (ready: () => boolean, what: string) =>
  Effect.gen(function* () {
    for (let waited = 0; !ready(); waited++) {
      if (waited > 3000) {
        return yield* Effect.die(`Timed out waiting for ${what}`);
      }
      yield* Effect.sleep("2 millis");
    }
  });

const startChat = Effect.gen(function* () {
  const chat = yield* openChat;
  const { posted, send } = chat;
  const ofType = (type: string, tab?: number) => posted.filter((m) => m.type === type && (tab === undefined || m.tab === tab));
  const tabsNow = () => ofType("tabs").at(-1) as { tabs: TabInfo[]; active: number };
  const say = (tab: number, text: string) => send({ type: "send", tab, parts: [text] });
  const replyOf = (tab: number) =>
    ofType("update", tab)
      .filter((m) => m.update.sessionUpdate === "agent_message_chunk")
      .map((m) => m.update.content.text)
      .join("");
  /** The running turn is over, so nothing is left to wind down when the view closes. */
  const idle = (tab: number) => until(() => ofType("status", tab).at(-1)?.busy === false, "the tab to be idle");
  send({ type: "ready" });
  yield* until(() => ofType("session").length === 1, "the first session");
  return { ...chat, ofType, tabsNow, say, replyOf, idle, tab: tabsNow().active };
});

beforeEach(() => {
  __test.reset();
  agentEnv = {};
  installed = true;
});

describe("ChatViewProvider", () => {
  describe("saving tabs", () => {
    const savedText = (context: vscode.ExtensionContext) => JSON.stringify(context.workspaceState.get("codeAcp.tabs") ?? null);

    it.live("writes a draft right away, as a window reload drops what isn't written yet", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { context, send, tab } = yield* startChat;
          const start = Date.now();
          send({ type: "draftText", tab, text: "unsent words" });
          yield* until(() => savedText(context).includes("unsent words"), "the draft to be written");
          assert.isBelow(Date.now() - start, 400);
        }),
      ),
    );

    it.live("writes a change soon after the last write", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { context, send, tab } = yield* startChat;
          const start = Date.now();
          send({ type: "renameTab", tab, title: "renamed" });
          yield* until(() => savedText(context).includes("renamed"), "the name to be written");
          assert.isBelow(Date.now() - start, 400);
        }),
      ),
    );

    it.live("keeps writing while changes keep coming", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { context, send, tab } = yield* startChat;
          let written = false;
          for (let n = 0; n < 40 && !written; n++) {
            send({ type: "renameTab", tab, title: `name ${n}` });
            yield* Effect.sleep("20 millis");
            written = savedText(context).includes("name ");
          }
          assert.isTrue(written);
        }),
      ),
    );
  });

  it.live("starts a session when the webview is ready", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { ofType, tab, tabsNow } = yield* startChat;
        assert.strictEqual(ofType("session", tab)[0]!.sessionId, "s1");
        assert.deepStrictEqual(ofType("agent")[0]!.agents.map((a: { id: string }) => a.id), ["mock"]);
        assert.strictEqual(ofType("folders").length, 1);
        assert.strictEqual(tabsNow().tabs.length, 1);
      }),
    ),
  );

  describe("permission rules", () => {
    it.live("answers what they allow without asking, naming it in the conversation", () =>
      Effect.scoped(
        Effect.gen(function* () {
          __test.setSetting("codeAcp.autoApprove", { execute: "allow" });
          const { ofType, say, replyOf, idle, tab } = yield* startChat;
          say(tab, "approvable execute");
          yield* until(() => replyOf(tab).includes("selected"), "the agent's answer");
          yield* idle(tab);
          assert.include(replyOf(tab), `"optionId":"allow"`);
          assert.strictEqual(ofType("permissionRequest", tab).length, 0);
          const notices = ofType("notice", tab).filter((m) => m.key === "chat.autoApproved");
          assert.deepStrictEqual(notices.map((m) => m.args), [["Do it"]]);
        }),
      ),
    );

    it.live("asks about what they don't, such as a read outside the tab's folder", () =>
      Effect.scoped(
        Effect.gen(function* () {
          __test.setSetting("codeAcp.autoApprove", { read: "allow" });
          const { ofType, say, send, replyOf, idle, tab } = yield* startChat;
          say(tab, `approvable read ${path.join(os.tmpdir(), "elsewhere.txt")}`);
          yield* until(() => ofType("permissionRequest", tab).length === 1, "the permission request");
          send({ type: "permission", id: ofType("permissionRequest", tab)[0]!.id, optionId: "deny" });
          yield* until(() => replyOf(tab).includes("selected"), "the agent's answer");
          yield* idle(tab);
          assert.include(replyOf(tab), `"optionId":"deny"`);
        }),
      ),
    );

    it.live("takes a workspace's rules from its state", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { ofType, say, send, context, replyOf, idle, tab } = yield* startChat;
          say(tab, "approvable execute");
          yield* until(() => ofType("permissionRequest", tab).length === 1, "the permission request");
          send({ type: "permission", id: ofType("permissionRequest", tab)[0]!.id, optionId: "allow" });
          yield* until(() => replyOf(tab).includes("selected"), "the agent's answer");
          yield* idle(tab);

          yield* Effect.promise(async () => context.workspaceState.update("codeAcp.autoApprove", { execute: "allow" }));
          say(tab, "approvable execute");
          yield* until(() => ofType("notice", tab).some((m) => m.key === "chat.autoApproved"), "the rule to answer");
          yield* idle(tab);
          assert.strictEqual(ofType("permissionRequest", tab).length, 1);
        }),
      ),
    );
  });

  it.live("with tracing on, shows a turn's numbers after it ends, with the wait for the user", () =>
    Effect.scoped(
      Effect.gen(function* () {
        __test.setSetting("codeAcp.tracing", true);
        const { ofType, say, send, idle, tab } = yield* startChat;
        assert.deepStrictEqual(ofType("tracing").at(-1), { type: "tracing", enabled: true });
        say(tab, "permission");
        yield* until(() => ofType("permissionRequest", tab).length === 1, "the permission request");
        send({ type: "permission", id: ofType("permissionRequest", tab)[0]!.id, optionId: "allow" });
        yield* until(() => ofType("turnTrace", tab).length === 1, "the turn's numbers");
        const { trace } = ofType("turnTrace", tab)[0]!;
        assert.strictEqual(trace.stopReason, "end_turn");
        assert.strictEqual(trace.waiting.asks, 1);
        assert.strictEqual(trace.number, 1);
        assert.isAtLeast(trace.firstResponseMs, 0);
        assert.deepStrictEqual(trace.changes, { files: 0, added: 0, removed: 0 });
        yield* idle(tab);
      }),
    ),
  );

  it.live("runs a turn: the message, the agent's reply and its end reach the webview", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { ofType, say, replyOf, idle, tab, tabsNow } = yield* startChat;
        say(tab, "updates");
        yield* until(() => ofType("turnEnd", tab).length === 1, "the end of the turn");
        assert.strictEqual(ofType("userMessage", tab)[0]!.text, "updates");
        assert.strictEqual(replyOf(tab), "hello world");
        assert.strictEqual(ofType("turnEnd", tab)[0]!.stopReason, "end_turn");
        yield* idle(tab);
        assert.strictEqual(tabsNow().tabs[0]!.title, "updates");
      }),
    ),
  );

  it.live("asks for a permission, queues what comes meanwhile and sends it after the answer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { ofType, say, send, replyOf, idle, tab } = yield* startChat;
        say(tab, "permission");
        yield* until(() => ofType("permissionRequest", tab).length === 1, "the permission request");
        say(tab, "updates");
        yield* until(() => ofType("queue", tab).at(-1)?.items.length === 1, "the queued message");
        send({ type: "permission", id: ofType("permissionRequest", tab)[0]!.id, optionId: "allow" });
        yield* until(() => ofType("turnEnd", tab).length === 2, "both turns");
        assert.strictEqual(ofType("permissionDone", tab).length, 1);
        assert.deepStrictEqual(ofType("userMessage", tab).map((m) => m.text), ["permission", "updates"]);
        assert.include(replyOf(tab), '"optionId":"allow"');
        assert.include(replyOf(tab), "hello world");
        assert.deepStrictEqual(ofType("queue", tab).at(-1)?.items, []);
        yield* idle(tab);
      }),
    ),
  );

  it.live("shows a failed turn in its tab", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { ofType, say, idle, tab } = yield* startChat;
        say(tab, "nonsense");
        yield* until(() => ofType("error", tab).length === 1, "the error");
        assert.include(ofType("error", tab)[0]!.text, "nonsense");
        yield* idle(tab);
        assert.deepStrictEqual(ofType("turnEnd", tab), []);
      }),
    ),
  );

  it.live("takes back what followed a message when it is sent again", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { ofType, say, send, idle, tab } = yield* startChat;
        say(tab, "updates");
        yield* until(() => ofType("turnEnd", tab).length === 1, "the first turn");
        yield* idle(tab);
        const { turn } = ofType("userMessage", tab)[0]!;
        send({ type: "editMessage", tab, turn });
        yield* until(() => ofType("loadComposer", tab).length === 1, "the message in the composer");
        assert.deepStrictEqual(ofType("loadComposer", tab)[0]!.rewind, turn);
        send({ type: "retry", tab, turn });
        yield* until(() => ofType("rewind", tab).length === 1, "the rewind");
        assert.strictEqual(ofType("rewind", tab)[0]!.turn, turn);
        // The mock takes the prompt's first word for its scenario, and the note about what was taken back comes first.
        yield* until(() => ofType("error", tab).length === 1, "the turn sent again");
        assert.include(ofType("error", tab)[0]!.text, "[Note");
        yield* idle(tab);
      }),
    ),
  );

  it.live("forks a conversation into a new active tab beside it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { ofType, say, send, idle, tab, tabsNow, replyOf } = yield* startChat;
        say(tab, "updates");
        yield* until(() => ofType("turnEnd", tab).length === 1, "the first turn");
        yield* idle(tab);
        send({ type: "fork", tab });
        yield* until(() => ofType("forked").length === 1, "the fork");
        const fork = tabsNow().active;
        assert.notStrictEqual(fork, tab);
        assert.strictEqual(ofType("forked", fork)[0]!.from, tab);
        assert.strictEqual(ofType("session", fork)[0]!.sessionId, "s1-fork");
        say(fork, "updates");
        yield* until(() => ofType("turnEnd", fork).length === 1, "a turn in the fork");
        assert.strictEqual(replyOf(fork), "hello world");
        yield* idle(fork);
      }),
    ),
  );

  it.live("delivers attachments from commands and ignores messages about a closed tab", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { ofType, send, provider, runtime, tab } = yield* startChat;
        yield* Effect.promise(() => runtime.runPromise(provider.composer.attach([Uri.file("/w/a.ts") as unknown as vscode.Uri])));
        assert.strictEqual(ofType("addAttachments")[0]!.attachments.length, 1);
        send({ type: "cancel", tab: tab + 100 });
        send({ type: "searchFiles", id: 7, query: "nothing-matches" });
        yield* until(() => ofType("files").length === 1, "the search result");
        assert.strictEqual(ofType("files")[0]!.id, 7);
        assert.deepStrictEqual(ofType("error"), []);
      }),
    ),
  );

  it.live("focuses the composer only after the focus command has moved focus to the view", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { posted, provider, runtime } = yield* startChat;
        const original = commands.executeCommand;
        const focused: number[] = [];
        commands.executeCommand = async () => {
          focused.push(posted.filter((m) => m.type === "focusComposer").length);
          return undefined;
        };
        yield* Effect.addFinalizer(() => Effect.sync(() => (commands.executeCommand = original)));
        yield* Effect.promise(() => runtime.runPromise(provider.composer.attach([Uri.file("/w/a.ts") as unknown as vscode.Uri])));
        assert.deepStrictEqual(focused, [0]);
        assert.strictEqual(posted.at(-1)!.type, "focusComposer");
      }),
    ),
  );

  it.live("opens another tab with its own session, and closes it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { ofType, send, tab, tabsNow } = yield* startChat;
        send({ type: "newTab" });
        yield* until(() => tabsNow().tabs.length === 2, "the new tab");
        const added = tabsNow().active;
        assert.notStrictEqual(added, tab);
        yield* until(() => ofType("session", added).length === 1, "its session");
        send({ type: "closeTab", tab: added });
        yield* until(() => tabsNow().tabs.length === 1, "the tab to close");
        assert.strictEqual(tabsNow().active, tab);
        assert.deepStrictEqual(ofType("error"), []);
      }),
    ),
  );

  it.live("closes the other tabs from the context menu, keeping pinned ones", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { ofType, provider, runtime, send, tab, tabsNow } = yield* startChat;
        const addTab = Effect.gen(function* () {
          const before = tabsNow().tabs.length;
          send({ type: "newTab" });
          yield* until(() => tabsNow().tabs.length === before + 1, "the new tab");
          const added = tabsNow().active;
          yield* until(() => ofType("session", added).length === 1, "its session");
          return added;
        });
        const pinned = yield* addTab;
        const other = yield* addTab;
        send({ type: "pinTab", tab: pinned, pinned: true });
        yield* until(() => tabsNow().tabs.some((t) => t.id === pinned && t.pinned), "the pin");
        const act = (id: number, action: Parameters<typeof provider.tabAction>[1]) => Effect.promise(() => runtime.runPromise(provider.tabAction(id, action)));
        yield* act(pinned, "close");
        assert.isTrue(tabsNow().tabs.some((t) => t.id === pinned));
        yield* act(tab, "closeOthers");
        assert.deepStrictEqual(tabsNow().tabs.map((t) => t.id).sort(), [tab, pinned].sort());
        assert.isFalse(tabsNow().tabs.some((t) => t.id === other));
        assert.strictEqual(tabsNow().active, tab);
        assert.deepStrictEqual(ofType("error"), []);
      }),
    ),
  );

  it.live("starts over in a fresh session when the agent restarts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { idle, ofType, provider, replyOf, runtime, say, tab } = yield* startChat;
        say(tab, "pid");
        yield* until(() => ofType("turnEnd", tab).length === 1, "the first turn");
        yield* idle(tab);
        const pid = replyOf(tab);
        yield* Effect.promise(() => runtime.runPromise(provider.restart()));
        yield* until(() => ofType("session", tab).length === 2, "the new session");
        assert.strictEqual(ofType("reset", tab).length, 1);
        say(tab, "pid");
        yield* until(() => ofType("turnEnd", tab).length === 2, "the second turn");
        yield* idle(tab);
        const restarted = replyOf(tab).slice(pid.length);
        assert.isNotEmpty(restarted);
        assert.notStrictEqual(restarted, pid);
        assert.deepStrictEqual(ofType("error"), []);
      }),
    ),
  );

  describe("restarting an agent that can reopen sessions", () => {
    const restartIn = (chat: { runtime: { runPromise: (effect: any) => Promise<unknown> }; provider: ChatViewProvider }, agentId?: string) =>
      Effect.promise(() => chat.runtime.runPromise(chat.provider.restart(agentId)));

    it.live("keeps the conversation of the active tab, and of the others until selected", () =>
      Effect.scoped(
        Effect.gen(function* () {
          agentEnv = { MOCK_LOAD: "1" };
          const chat = yield* startChat;
          const { idle, ofType, replyOf, say, send, tab, tabsNow } = chat;
          say(tab, "pid");
          yield* until(() => ofType("turnEnd", tab).length === 1, "the first turn");
          yield* idle(tab);
          const pid = replyOf(tab);
          send({ type: "newTab" });
          yield* until(() => tabsNow().tabs.length === 2, "the second tab");
          const other = tabsNow().active;
          yield* until(() => ofType("session", other).length === 1, "its session");
          say(other, "updates");
          yield* until(() => ofType("turnEnd", other).length === 1, "its turn");
          yield* idle(other);

          yield* restartIn(chat);
          yield* until(() => ofType("session", other).length === 2, "the active tab's session again");
          assert.include(replyOf(other), "replayed s2");
          assert.strictEqual(ofType("reset", other).length, 1);
          assert.strictEqual(tabsNow().tabs.find((each) => each.id === other)!.title, "updates");

          // The other tab waits, its transcript untouched.
          assert.strictEqual(ofType("reset", tab).length, 0);
          assert.strictEqual(ofType("status", tab).at(-1)!.stopped, true);
          send({ type: "selectTab", tab });
          yield* until(() => ofType("session", tab).length === 2, "the other tab's session again");
          assert.include(replyOf(tab), "replayed s1");
          assert.strictEqual(tabsNow().tabs.find((each) => each.id === tab)!.title, "pid");

          say(tab, "pid");
          yield* until(() => ofType("turnEnd", tab).length === 2, "a turn after restarting");
          yield* idle(tab);
          assert.notInclude(replyOf(tab).slice(pid.length + "replayed s1".length), pid);
          assert.deepStrictEqual(ofType("error"), []);
        }),
      ),
    );

    it.live("keeps a running turn's queue and sends it once the session is back", () =>
      Effect.scoped(
        Effect.gen(function* () {
          agentEnv = { MOCK_LOAD: "1" };
          const chat = yield* startChat;
          const { idle, ofType, replyOf, say, tab } = chat;
          say(tab, "permission");
          yield* until(() => ofType("permissionRequest", tab).length === 1, "the permission request");
          say(tab, "updates");
          yield* until(() => ofType("queue", tab).at(-1)?.items.length === 1, "the queued message");
          yield* restartIn(chat);
          yield* until(() => ofType("turnEnd", tab).length === 1, "the queued turn");
          yield* idle(tab);
          assert.strictEqual(ofType("userMessage", tab).at(-1)!.text, "updates");
          assert.include(replyOf(tab), "replayed s1");
          assert.include(replyOf(tab), "hello world");
          assert.deepStrictEqual(ofType("queue", tab).at(-1)?.items, []);
          assert.deepStrictEqual(ofType("error", tab), []);
        }),
      ),
    );

    it.live("starts over when the agent was removed", () =>
      Effect.scoped(
        Effect.gen(function* () {
          agentEnv = { MOCK_LOAD: "1" };
          const chat = yield* startChat;
          const { idle, ofType, replyOf, say, tab, tabsNow } = chat;
          say(tab, "updates");
          yield* until(() => ofType("turnEnd", tab).length === 1, "the turn");
          yield* idle(tab);
          installed = false;
          yield* restartIn(chat, "mock");
          yield* until(() => ofType("session", tab).length === 2, "the new session");
          assert.strictEqual(ofType("reset", tab).length, 1);
          assert.notInclude(replyOf(tab), "replayed");
          assert.isUndefined(tabsNow().tabs[0]!.title);
        }),
      ),
    );

    it.live("reopens the conversation after a terminal login", () =>
      Effect.scoped(
        Effect.gen(function* () {
          agentEnv = { MOCK_LOAD: "1", MOCK_TERMINAL_AUTH: "1" };
          const { idle, ofType, provider, replyOf, runtime, say, tab, tabsNow } = yield* startChat;
          say(tab, "updates");
          yield* until(() => ofType("turnEnd", tab).length === 1, "the first turn");
          yield* idle(tab);
          say(tab, "expired");
          yield* until(() => ofType("status", tab).at(-1)?.needsLogin === true, "the login request");
          const login = runtime.runPromise(provider.login());
          yield* until(() => __test.terminals.length === 1, "the login terminal");
          __test.closeTerminal(__test.terminals[0]);
          yield* Effect.promise(() => login);
          yield* until(() => ofType("session", tab).length === 2, "the session again");
          assert.include(replyOf(tab), "replayed s1");
          assert.strictEqual(tabsNow().tabs[0]!.title, "updates");
          assert.deepStrictEqual(ofType("error"), []);
        }),
      ),
    );
  });

  describe("asking before something final", () => {
    const showWarningMessage = window.showWarningMessage;
    /** Answers the next questions with their action, or turns them down. */
    const answering = (yes: boolean) => {
      const asked: string[] = [];
      window.showWarningMessage = async (message, _options, ...actions) => {
        asked.push(message);
        return yes ? actions[0] : undefined;
      };
      return asked;
    };
    afterEach(() => {
      window.showWarningMessage = showWarningMessage;
    });

    it.live("deletes a past session from the history, after asking", () =>
      Effect.gen(function* () {
        agentEnv = { MOCK_HISTORY: "1" };
        const { ofType, send } = yield* startChat;
        const listed = () => ofType("history").at(-1)!;
        send({ type: "history" });
        yield* until(() => ofType("history").at(-1)?.sessions.length === 1, "the list");
        assert.strictEqual(listed().canDelete, true);

        const asked = answering(false);
        send({ type: "deleteSession", sessionId: "old", title: "Session old" });
        yield* until(() => asked.length === 1, "the question");
        assert.include(asked[0], "Session old");
        yield* Effect.sleep("20 millis");
        assert.deepStrictEqual(ofType("sessionDeleted"), []);

        answering(true);
        send({ type: "deleteSession", sessionId: "old" });
        yield* until(() => ofType("sessionDeleted").length === 1, "the deletion");
        assert.strictEqual(ofType("sessionDeleted")[0]!.sessionId, "old");
        const before = ofType("history").length;
        send({ type: "history" });
        yield* until(() => ofType("history").length === before + 2, "the new list");
        assert.deepStrictEqual(listed().sessions, []);
      }).pipe(Effect.scoped),
    );

    it.live("keeps the session of an open tab", () =>
      Effect.gen(function* () {
        agentEnv = { MOCK_HISTORY: "1" };
        const { ofType, send, tab } = yield* startChat;
        const asked = answering(true);
        const sessionId = ofType("session", tab)[0]!.sessionId as string;
        send({ type: "deleteSession", sessionId });
        yield* Effect.sleep("50 millis");
        assert.deepStrictEqual(asked, []);
        assert.deepStrictEqual(ofType("sessionDeleted"), []);
      }).pipe(Effect.scoped),
    );

    it.live("says so when the agent can't delete the session", () =>
      Effect.gen(function* () {
        agentEnv = { MOCK_HISTORY: "1" };
        const { ofType, send } = yield* startChat;
        answering(true);
        const errors: string[] = [];
        const showErrorMessage = window.showErrorMessage;
        window.showErrorMessage = async (message) => {
          errors.push(message);
          return undefined;
        };
        send({ type: "deleteSession", sessionId: "gone" });
        yield* until(() => errors.length === 1, "the error");
        window.showErrorMessage = showErrorMessage;
        assert.deepStrictEqual(ofType("sessionDeleted"), []);
      }).pipe(Effect.scoped),
    );

    it.live("logs out and restarts the agent, whose tabs then need a login", () =>
      Effect.gen(function* () {
        agentEnv = { MOCK_LOGOUT: "1" };
        const { ofType, provider, runtime, tab } = yield* startChat;
        answering(false);
        yield* Effect.promise(() => runtime.runPromise(provider.logout()));
        assert.isFalse(ofType("status", tab).some((m) => m.needsLogin));

        answering(true);
        // The next process finds the user logged out.
        agentEnv = { MOCK_LOGOUT: "1", MOCK_AUTH: "1" };
        yield* Effect.promise(() => runtime.runPromise(provider.logout()));
        yield* until(() => ofType("status", tab).at(-1)?.needsLogin === true, "the login to be asked for");
      }).pipe(Effect.scoped),
    );

    it.live("doesn't ask to log out of an agent that can't", () =>
      Effect.gen(function* () {
        const { ofType, provider, runtime } = yield* startChat;
        const asked = answering(true);
        const before = ofType("session").length;
        yield* Effect.promise(() => runtime.runPromise(provider.logout()));
        assert.deepStrictEqual(asked, []);
        assert.strictEqual(ofType("session").length, before);
      }).pipe(Effect.scoped),
    );
  });

  describe("links the agent asks to open", () => {
    it.live("opens the link when the user agrees, as it is, and tells when it is done", () =>
      Effect.gen(function* () {
        const { idle, ofType, replyOf, say, send, tab } = yield* startChat;
        say(tab, "elicit url");
        yield* until(() => ofType("elicitationRequest", tab).length === 1, "the question");
        const asked = ofType("elicitationRequest", tab)[0]!;
        assert.strictEqual(asked.url, "https://example.com/login?next=a%26b");
        assert.strictEqual(asked.elicitationId, "e1");
        assert.isUndefined(asked.schema);
        assert.deepStrictEqual(__test.openedExternal, []);

        // What the webview adds to its answer doesn't reach the agent.
        send({ type: "elicitation", id: asked.id, response: { action: "accept", content: { extra: "x" } } });
        yield* until(() => ofType("elicitationComplete", tab).length === 1, "the link to complete");
        yield* idle(tab);
        assert.deepStrictEqual(__test.openedExternal, ["https://example.com/login?next=a%26b"]);
        assert.deepStrictEqual(JSON.parse(replyOf(tab)), { action: "accept" });
      }).pipe(Effect.scoped),
    );

    it.live("stops asking when the agent says it is done before the user answered", () =>
      Effect.gen(function* () {
        const { idle, ofType, replyOf, say, tab } = yield* startChat;
        say(tab, "elicit finished");
        yield* until(() => ofType("elicitationComplete", tab).length === 1, "the link to complete");
        yield* until(() => ofType("turnEnd", tab).length === 1, "the turn");
        yield* idle(tab);
        assert.deepStrictEqual(ofType("elicitationDone", tab).map((m) => m.action), ["cancel"]);
        assert.deepStrictEqual(__test.openedExternal, []);
        assert.deepStrictEqual(JSON.parse(replyOf(tab)), { action: "cancel" });
      }).pipe(Effect.scoped),
    );

    it.live("doesn't open it when the user declines", () =>
      Effect.gen(function* () {
        const { idle, ofType, replyOf, say, send, tab } = yield* startChat;
        say(tab, "elicit url");
        yield* until(() => ofType("elicitationRequest", tab).length === 1, "the question");
        send({ type: "elicitation", id: ofType("elicitationRequest", tab)[0]!.id, response: { action: "decline" } });
        yield* until(() => ofType("turnEnd", tab).length === 1, "the turn");
        yield* idle(tab);
        assert.deepStrictEqual(__test.openedExternal, []);
        assert.deepStrictEqual(JSON.parse(replyOf(tab)), { action: "decline" });
      }).pipe(Effect.scoped),
    );

    it.live("tells the agent when VS Code didn't open it", () =>
      Effect.gen(function* () {
        __test.openExternalResult = false;
        const { idle, ofType, replyOf, say, send, tab } = yield* startChat;
        say(tab, "elicit url");
        yield* until(() => ofType("elicitationRequest", tab).length === 1, "the question");
        send({ type: "elicitation", id: ofType("elicitationRequest", tab)[0]!.id, response: { action: "accept" } });
        yield* until(() => ofType("turnEnd", tab).length === 1, "the turn");
        yield* idle(tab);
        assert.deepStrictEqual(JSON.parse(replyOf(tab)), { action: "cancel" });
        assert.isTrue(ofType("notice", tab).some((m) => m.key === "chat.elicitation.notOpened"));
      }).pipe(Effect.scoped),
    );

    it.live("asks about an http link once the user listed its host", () =>
      Effect.gen(function* () {
        __test.setSetting("codeAcp.allowedHttpHosts", ["example.com"]);
        const { ofType, say, send, tab } = yield* startChat;
        say(tab, "elicit unsafe");
        yield* until(() => ofType("elicitationRequest", tab).length === 1, "the question");
        assert.strictEqual(ofType("elicitationRequest", tab)[0]!.url, "http://example.com/login");
        send({ type: "elicitation", id: ofType("elicitationRequest", tab)[0]!.id, response: { action: "decline" } });
        yield* until(() => ofType("turnEnd", tab).length === 1, "the turn");
      }).pipe(Effect.scoped),
    );

    it.live("refuses a link that isn't safe without asking", () =>
      Effect.gen(function* () {
        const { idle, ofType, replyOf, say, tab } = yield* startChat;
        say(tab, "elicit unsafe");
        yield* until(() => ofType("turnEnd", tab).length === 1, "the turn");
        yield* idle(tab);
        assert.deepStrictEqual(ofType("elicitationRequest", tab), []);
        assert.deepStrictEqual(__test.openedExternal, []);
        assert.deepStrictEqual(JSON.parse(replyOf(tab)), { action: "decline" });
        assert.isTrue(ofType("notice", tab).some((m) => m.key === "chat.elicitation.unsafeUrl"));
      }).pipe(Effect.scoped),
    );
  });

  it.live("sets the mode of an agent that only offers modes", () =>
    Effect.gen(function* () {
      agentEnv = { MOCK_MODES: "1" };
      const { idle, ofType, replyOf, say, send, tab } = yield* startChat;
      const option = ofType("session", tab)[0]!.configOptions[0];
      assert.strictEqual(option.category, "mode");
      assert.strictEqual(option.currentValue, "ask");
      send({ type: "setConfig", tab, configId: option.id, value: "code" });
      yield* until(() => ofType("configOptions", tab).length === 1, "the new options");
      assert.strictEqual(ofType("configOptions", tab)[0]!.configOptions[0].currentValue, "code");
      say(tab, "mode");
      yield* until(() => ofType("turnEnd", tab).length === 1, "the turn");
      yield* idle(tab);
      assert.strictEqual(replyOf(tab), "code");
    }).pipe(Effect.scoped),
  );

  it.live("forwards compaction to the transcript", () =>
    Effect.gen(function* () {
      const { idle, ofType, say, tab } = yield* startChat;
      say(tab, "compact");
      yield* until(() => ofType("turnEnd", tab).length === 1, "the turn");
      yield* idle(tab);
      const updates = ofType("update", tab).map((m) => m.update.sessionUpdate);
      assert.deepStrictEqual(updates.filter((u) => u.startsWith("compaction")), [
        "compaction_update",
        "compaction_summary_chunk",
        "compaction_summary_chunk",
        "compaction_update",
      ]);
    }).pipe(Effect.scoped),
  );

  it.live("shows the tab waiting for a permission", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { idle, ofType, provider, runtime, say, send, tab, tabsNow } = yield* startChat;
        say(tab, "permission");
        yield* until(() => ofType("permissionRequest", tab).length === 1, "the permission request");
        send({ type: "newTab" });
        yield* until(() => tabsNow().tabs.length === 2, "the new tab");
        const added = tabsNow().active;
        assert.notStrictEqual(added, tab);
        yield* until(() => ofType("session", added).length === 1, "its session");
        yield* Effect.promise(() => runtime.runPromise(provider.showAttention()));
        assert.strictEqual(tabsNow().active, tab);
        send({ type: "permission", id: ofType("permissionRequest", tab)[0]!.id, optionId: "allow" });
        yield* until(() => ofType("turnEnd", tab).length === 1, "the turn");
        yield* idle(tab);
        assert.deepStrictEqual(ofType("error"), []);
      }),
    ),
  );
});
