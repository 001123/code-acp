import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type * as vscode from "vscode";
import type { AgentManager } from "../src/agentManager";
import type { AgentUpdates } from "../src/agentUpdates";
import { ChatViewProvider } from "../src/chat/chatViewProvider";
import type { FromWebview, TabGroupInfo, TabInfo } from "../src/chat/protocol";
import { TabList } from "../src/chat/tabs";
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
let agentList = [{ id: "mock", name: "Mock" }];
let activeAgent: string | undefined = "mock";
const managerChanged = new EventEmitter<void>();

const manager = {
  onDidChange: managerChanged.event,
  agents: Effect.sync(() => agentList),
  has: (id: string) => Effect.sync(() => installed && agentList.some((agent) => agent.id === id)),
  command: () => Effect.sync(() => ({ command: process.execPath, args: [MOCK_AGENT], env: { ...process.env, MOCK_FORK: "1", ...agentEnv } })),
  activeId: Effect.sync(() => activeAgent),
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
  const tabsNow = () => ofType("tabs").at(-1) as { tabs: TabInfo[]; groups: TabGroupInfo[]; active: number; shownGroup?: number };
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
  agentList = [{ id: "mock", name: "Mock" }];
  activeAgent = "mock";
});

describe("ChatViewProvider", () => {
  it.live("checks the tools for the first-run panel and opens where to get a missing one", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { posted, send } = yield* openChat;
        const saved = process.env.PATH;
        process.env.PATH = "";
        yield* Effect.addFinalizer(() => Effect.sync(() => void (process.env.PATH = saved)));
        const last = () => posted.filter((m) => m.type === "doctor").at(-1)?.doctor;
        send({ type: "doctorRun" });
        yield* until(() => last()?.rows.length > 0 && !last().running, "the check to end");
        assert.deepStrictEqual(last().rows.map((row: Posted) => row.id), ["node", "npm", "uv", "git"]);
        assert.strictEqual(last().rows[1].result.status, "error");

        send({ type: "doctorFix", id: "npm" });
        yield* until(() => __test.openedExternal.length === 1, "the download page");
      }),
    ),
  );

  it.live("starts the session of the tab waiting for an agent once one is installed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        agentList = [];
        activeAgent = undefined;
        const { posted, send } = yield* openChat;
        const ofType = (type: string) => posted.filter((m) => m.type === type);
        send({ type: "ready" });
        yield* until(() => ofType("status").at(-1)?.needsAgent === true, "the tab to ask for an agent");
        assert.deepStrictEqual(ofType("agent").at(-1)?.agents, []);

        agentList = [{ id: "mock", name: "Mock" }];
        activeAgent = "mock";
        managerChanged.fire();
        yield* until(() => ofType("session").length === 1, "the session");
        assert.isUndefined(ofType("status").at(-1)?.needsAgent);
      }),
    ),
  );

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

  it.live("offers to restore a message's checkpoint only with the setting on", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { ofType, say, idle, tab } = yield* startChat;
        const file = path.join(workspace.workspaceFolders![0]!.uri.fsPath, "file.txt");
        say(tab, `write ${file}`);
        yield* idle(tab);
        const changes = () => ofType("changes", tab).at(-1);
        yield* until(() => changes()?.files.length === 1, "the changed file");
        assert.deepStrictEqual(changes()!.turns, []);
        __test.setSetting("codeAcp.showRestore", true);
        yield* until(() => changes()!.turns.length === 1, "the checkpoint");
        __test.setSetting("codeAcp.showRestore", false);
        yield* until(() => changes()!.turns.length === 0, "the checkpoint to go");
      }),
    ),
  );

  it.live("keeps the gear's General settings in step with the configuration", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { ofType } = yield* startChat;
        assert.deepStrictEqual(ofType("showRestore").at(-1), { type: "showRestore", enabled: false });
        assert.deepStrictEqual(ofType("rememberSessionOptions").at(-1), { type: "rememberSessionOptions", enabled: true });
        __test.setSetting("codeAcp.showRestore", true);
        __test.setSetting("codeAcp.rememberSessionOptions", false);
        yield* until(() => ofType("rememberSessionOptions").at(-1)?.enabled === false, "the setting");
        assert.deepStrictEqual(ofType("showRestore").at(-1), { type: "showRestore", enabled: true });
        assert.deepStrictEqual(ofType("rememberSessionOptions").at(-1), { type: "rememberSessionOptions", enabled: false });
      }),
    ),
  );

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
        assert.strictEqual(tabsNow().tabs[0]!.used, false);
        say(tab, "updates");
        yield* until(() => ofType("turnEnd", tab).length === 1, "the end of the turn");
        assert.strictEqual(tabsNow().tabs[0]!.used, true);
        assert.strictEqual(ofType("userMessage", tab)[0]!.text, "updates");
        assert.strictEqual(replyOf(tab), "hello world");
        assert.strictEqual(ofType("turnEnd", tab)[0]!.stopReason, "end_turn");
        yield* idle(tab);
        assert.strictEqual(tabsNow().tabs[0]!.title, "updates");
      }),
    ),
  );

  it.live("sends a new tab's message where it is when the setting ticks its box outside git", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { ofType, say, send, tabsNow, idle } = yield* startChat;
        __test.setSetting("codeAcp.worktreeForNewTabs", true);
        send({ type: "newTab" });
        yield* until(() => tabsNow().tabs.length === 2, "the new tab");
        const added = tabsNow().active;
        const info = () => tabsNow().tabs.find((each) => each.id === added)!;
        yield* until(() => ofType("session", added).length === 1, "its session");
        say(added, "updates");
        yield* until(() => ofType("turnEnd", added).length === 1, "the turn");
        yield* idle(added);
        assert.isUndefined(info().worktree);
        assert.isNotOk(info().worktreeOnSend);
        assert.strictEqual(ofType("loadComposer", added).length, 0);
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

  it.live("exports a conversation from the webview's Markdown to the file the user picks", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { ofType, provider, root, runtime, send, tab, tabsNow } = yield* startChat;
        yield* Effect.promise(() => runtime.runPromise(provider.tabAction(tab, "export")));
        assert.deepStrictEqual(ofType("exportConversation").at(-1), { type: "exportConversation", tab });
        yield* Effect.promise(() => runtime.runPromise(provider.exportConversation));
        assert.lengthOf(ofType("exportConversation"), 2);

        const target = path.join(root, "out.md");
        const defaults: string[] = [];
        const saveDialog = window.showSaveDialog;
        window.showSaveDialog = async (options?: unknown) => {
          defaults.push((options as { defaultUri: Uri }).defaultUri.fsPath);
          return Uri.file(target);
        };
        yield* Effect.addFinalizer(() => Effect.sync(() => void (window.showSaveDialog = saveDialog)));
        send({ type: "renameTab", tab, title: "a/b" });
        yield* until(() => tabsNow().tabs.find((t) => t.id === tab)?.title === "a/b", "the name");
        send({ type: "saveConversation", tab, markdown: "# Hello\n" });
        yield* until(() => defaults.length === 1, "the save dialog");
        assert.strictEqual(path.basename(defaults[0]!), "a b.md");
        const written = yield* Effect.promise(async () => {
          for (;;) {
            const text = await fs.readFile(target, "utf8").catch(() => undefined);
            if (text) return text;
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
        });
        assert.strictEqual(written, "# Hello\n");

        // Nothing to save: no dialog.
        send({ type: "saveConversation", tab, markdown: "" });
        yield* Effect.sleep("20 millis");
        assert.lengthOf(defaults, 1);
        assert.deepStrictEqual(ofType("error"), []);
      }),
    ),
  );

  it.live("asks the webview for the find box", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { ofType, provider, runtime } = yield* startChat;
        yield* Effect.promise(() => runtime.runPromise(provider.findInConversation));
        assert.lengthOf(ofType("findInConversation"), 1);
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

  it.live("shows a background tab idle when a restart cuts off its turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { idle, ofType, provider, runtime, say, send, tab, tabsNow } = yield* startChat;
        say(tab, "permission");
        yield* until(() => ofType("permissionRequest", tab).length === 1, "the permission request");
        assert.strictEqual(ofType("status", tab).at(-1)!.busy, true);
        send({ type: "newTab" });
        yield* until(() => tabsNow().active !== tab, "the new tab");
        yield* Effect.promise(() => runtime.runPromise(provider.restart()));
        yield* until(() => ofType("reset", tab).length === 1, "the reset");
        yield* idle(tab);
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

    it.live("lists the conversations without taking the focus, and tells the tabs' sessions", () =>
      Effect.gen(function* () {
        agentEnv = { MOCK_HISTORY: "1" };
        const { ofType, send, tabsNow } = yield* startChat;
        const focused: unknown[] = [];
        const { executeCommand } = commands;
        commands.executeCommand = async (...args) => void focused.push(args[0]);
        yield* Effect.addFinalizer(() => Effect.sync(() => void (commands.executeCommand = executeCommand)));
        send({ type: "history" });
        yield* until(() => ofType("history").at(-1)?.sessions.length === 1, "the list");
        assert.deepStrictEqual(focused, []);
        assert.isString(tabsNow().tabs[0]!.sessionId);
      }).pipe(Effect.scoped),
    );

    it.live("keeps a failure to list the conversations out of the conversation", () =>
      Effect.gen(function* () {
        agentEnv = { MOCK_LIST_FAIL: "1" };
        const { ofType, send, tab } = yield* startChat;
        send({ type: "history" });
        yield* until(() => ofType("history").at(-1)?.error !== undefined, "the failure");
        assert.deepStrictEqual(ofType("history").at(-1)!.sessions, []);
        assert.deepStrictEqual(ofType("error", tab), []);
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

    it.live("logs in to another agent in a new tab, leaving the active one alone", () =>
      Effect.gen(function* () {
        agentList = [{ id: "mock", name: "Mock" }, { id: "other", name: "Other" }];
        const { runtime, provider, tabsNow, tab } = yield* startChat;
        agentEnv = { MOCK_AUTH: "1", MOCK_TERMINAL_AUTH: "1" };
        const login = runtime.runPromise(provider.loginTo("other"));
        yield* until(() => __test.terminals.length === 1, "the login terminal");
        const { active, tabs } = tabsNow();
        assert.notStrictEqual(active, tab);
        assert.lengthOf(tabs, 2);
        assert.strictEqual(tabs.find((info) => info.id === active)?.agentId, "other");
        __test.closeTerminal(__test.terminals[0]);
        yield* Effect.promise(() => login);
      }),
    );

    it.live("logs in to the active tab's agent without opening a tab", () =>
      Effect.gen(function* () {
        agentEnv = { MOCK_TERMINAL_AUTH: "1" };
        const { runtime, provider, tabsNow } = yield* startChat;
        const login = runtime.runPromise(provider.loginTo("mock"));
        yield* until(() => __test.terminals.length === 1, "the login terminal");
        assert.lengthOf(tabsNow().tabs, 1);
        __test.closeTerminal(__test.terminals[0]);
        yield* Effect.promise(() => login);
      }),
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

  describe("best of N", () => {
    const showWarningMessage = window.showWarningMessage;
    const realHome = process.env.HOME;
    const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
    /** The question's first action, or none. */
    const answering = (yes: boolean) => {
      const asked: string[] = [];
      window.showWarningMessage = async (message, _options, ...actions) => {
        asked.push(message);
        return yes ? actions[0] : undefined;
      };
      return asked;
    };
    const both = [
      { agentId: "mock", model: "", effort: "" },
      { agentId: "other", model: "", effort: "" },
    ];

    beforeEach(() => {
      agentList = [
        { id: "mock", name: "Mock" },
        { id: "other", name: "Other" },
      ];
    });
    afterEach(() => {
      window.showWarningMessage = showWarningMessage;
      process.env.HOME = realHome;
    });

    /** A chat in a git repository, with the worktrees under a home of its own. */
    const startInRepo = Effect.gen(function* () {
      const chat = yield* startChat;
      const folder = path.join(chat.root, "workspace");
      process.env.HOME = path.join(chat.root, "home");
      yield* Effect.promise(async () => {
        await fs.mkdir(process.env.HOME!);
        await fs.writeFile(path.join(folder, "a.txt"), "one\n");
      });
      git(folder, "init", "--quiet");
      git(folder, "add", "--all");
      git(folder, "commit", "--quiet", "-m", "init");
      const members = () => chat.tabsNow().tabs.filter((tab) => tab.group !== undefined);
      const finished = until(() => members().length === 2 && members().every((tab) => tab.attempt === "done"), "both agents to finish");
      const started = (prompt: string) =>
        Effect.gen(function* () {
          chat.send({ type: "bestOf", tab: chat.tab, parts: [prompt], attempts: both });
          yield* finished;
          for (const tab of members()) {
            yield* chat.idle(tab.id);
          }
        });
      return { ...chat, folder, members, started };
    });

    it.live("runs each agent on the prompt in a worktree of its own, and shows the group", () =>
      Effect.gen(function* () {
        const { folder, members, started, replyOf, tabsNow, tab } = yield* startInRepo;
        yield* started("updates first\nand more");
        const [first, second] = members();
        assert.deepStrictEqual(
          members().map((each) => each.agentId),
          ["mock", "other"],
        );
        assert.isDefined(first!.worktree);
        assert.isDefined(second!.worktree);
        assert.notStrictEqual(first!.worktree!.root, second!.worktree!.root);
        assert.strictEqual(first!.worktree!.branch, "code-acp/compare/updates-first-mock");
        assert.strictEqual(second!.worktree!.branch, "code-acp/compare/updates-first-other");
        assert.notStrictEqual(first!.cwd, folder);
        assert.isNotEmpty(replyOf(first!.id));
        assert.isNotEmpty(replyOf(second!.id));
        const { groups, shownGroup, active } = tabsNow();
        assert.strictEqual(groups.length, 1);
        assert.strictEqual(groups[0]!.title, "updates first");
        assert.strictEqual(groups[0]!.prompt, "updates first\nand more");
        assert.strictEqual(shownGroup, groups[0]!.id);
        // The tab that sent it stays where it was.
        assert.strictEqual(active, tab);
      }).pipe(Effect.scoped),
    );

    it.live("compares what the worktrees changed, applies one and deletes them all with the group", () =>
      Effect.gen(function* () {
        const { folder, members, started, send, ofType, tabsNow, tab } = yield* startInRepo;
        yield* started("updates");
        const [winner, loser] = members();
        yield* Effect.promise(() => fs.writeFile(path.join(winner!.worktree!.root, "new.txt"), "hi\nthere\n"));
        const diffOf = (id: number) => ofType("worktreeDiff", id).at(-1)?.diff;
        const posted = ofType("worktreeDiff").length;
        send({ type: "refreshGroup", group: winner!.group! });
        yield* until(() => ofType("worktreeDiff").length === posted + 2, "the counts");
        assert.deepStrictEqual(diffOf(winner!.id), { files: [{ path: "new.txt", added: 2, removed: 0 }] });
        assert.deepStrictEqual(diffOf(loser!.id), { files: [] });

        const asked = answering(true);
        send({ type: "applyWorktree", tab: winner!.id });
        yield* until(() => members()[0]!.applied === true, "the changes to be applied");
        assert.strictEqual(asked.length, 1);
        assert.strictEqual(git(folder, "status", "--porcelain").trim(), "A  new.txt");

        // Nothing is left to lose: applied, or without changes.
        send({ type: "closeGroup", group: winner!.group! });
        yield* until(() => tabsNow().groups.length === 0, "the group to close");
        assert.strictEqual(asked.length, 1);
        assert.strictEqual(tabsNow().tabs.length, 1);
        assert.strictEqual(tabsNow().active, tab);
        assert.isUndefined(tabsNow().shownGroup);
        yield* until(() => git(folder, "worktree", "list").trim().split("\n").length === 1, "the worktrees to go");
        assert.notInclude(git(folder, "branch"), winner!.worktree!.branch!);
      }).pipe(Effect.scoped),
    );

    it.live("asks once before closing a group whose worktrees hold changes, and leaves it when turned down", () =>
      Effect.gen(function* () {
        const { members, started, send, tabsNow } = yield* startInRepo;
        yield* started("updates");
        const [first, second] = members();
        yield* Effect.promise(async () => {
          await fs.writeFile(path.join(first!.worktree!.root, "x.txt"), "x\n");
          await fs.writeFile(path.join(second!.worktree!.root, "y.txt"), "y\n");
        });
        const asked = answering(false);
        send({ type: "closeGroup", group: first!.group! });
        yield* until(() => asked.length === 1, "the question");
        yield* Effect.sleep("20 millis");
        assert.include(asked[0], "2 worktree");
        assert.strictEqual(tabsNow().groups.length, 1);
        assert.strictEqual(members().length, 2);
      }).pipe(Effect.scoped),
    );

    it.live("discards a group after asking: its tabs close and its worktrees go, changes and all", () =>
      Effect.gen(function* () {
        const { folder, members, started, send, tabsNow, tab } = yield* startInRepo;
        yield* started("updates");
        const [first, second] = members();
        yield* Effect.promise(() => fs.writeFile(path.join(first!.worktree!.root, "x.txt"), "x\n"));
        const worktreeCount = () => git(folder, "worktree", "list").trim().split("\n").length;

        const declined = answering(false);
        send({ type: "discardGroup", group: first!.group! });
        yield* until(() => declined.length === 1, "the question");
        yield* Effect.sleep("20 millis");
        assert.include(declined[0], "updates");
        assert.strictEqual(tabsNow().groups.length, 1);
        assert.strictEqual(worktreeCount(), 3);

        const asked = answering(true);
        send({ type: "discardGroup", group: first!.group! });
        yield* until(() => tabsNow().groups.length === 0, "the group to go");
        assert.strictEqual(asked.length, 1);
        assert.strictEqual(tabsNow().active, tab);
        assert.isUndefined(tabsNow().shownGroup);
        yield* until(() => worktreeCount() === 1, "the worktrees to go");
        const branches = git(folder, "branch");
        assert.notInclude(branches, first!.worktree!.branch!);
        assert.notInclude(branches, second!.worktree!.branch!);
        assert.strictEqual(git(folder, "status", "--porcelain").trim(), "");
      }).pipe(Effect.scoped),
    );

    it.live("discards a group without asking when nothing would be lost", () =>
      Effect.gen(function* () {
        const { folder, members, started, send, tabsNow } = yield* startInRepo;
        yield* started("updates");
        const asked = answering(false);
        send({ type: "discardGroup", group: members()[0]!.group! });
        yield* until(() => tabsNow().groups.length === 0, "the group to go");
        assert.deepStrictEqual(asked, []);
        yield* until(() => git(folder, "worktree", "list").trim().split("\n").length === 1, "the worktrees to go");
      }).pipe(Effect.scoped),
    );

    it.live("leaves no worktree behind for a group discarded while its agents start", () =>
      Effect.gen(function* () {
        const { folder, members, send, tabsNow, tab } = yield* startInRepo;
        answering(true);
        send({ type: "bestOf", tab, parts: ["updates"], attempts: both });
        yield* until(() => members().length === 2, "the group");
        send({ type: "discardGroup", group: members()[0]!.group! });
        yield* until(() => tabsNow().groups.length === 0, "the group to go");
        // What was on its way when the group went has to land, and be cleaned up.
        yield* Effect.sleep("500 millis");
        yield* until(() => git(folder, "worktree", "list").trim().split("\n").length === 1, "the worktrees to go");
      }).pipe(Effect.scoped),
    );

    it.live("starts each attempt on the model and effort picked for it, without changing what the agent's next sessions start with", () =>
      Effect.gen(function* () {
        agentEnv = { MOCK_MODELS: "1" };
        const { send, members, ofType, tabsNow, tab, context } = yield* startInRepo;
        send({
          type: "bestOf",
          tab,
          parts: ["updates"],
          attempts: [
            { agentId: "mock", model: "big", effort: "high", label: "Big · High" },
            { agentId: "mock", model: "small", effort: "", label: "Small" },
          ],
        });
        yield* until(() => members().length === 2 && members().every((each) => each.attempt === "done"), "both to finish");
        const [big, small] = members();
        const picked = (id: number) =>
          (ofType("session", id).at(-1)!.configOptions as Array<{ id: string; currentValue: string }>).map((option) => option.currentValue);
        assert.deepStrictEqual(picked(big!.id), ["big", "high"]);
        assert.deepStrictEqual(picked(small!.id), ["small", "low"]);
        assert.strictEqual(big!.attemptLabel, "Big · High");
        assert.isUndefined(context.globalState.get("codeAcp.lastSessionOptions"));
        for (const each of members()) {
          yield* until(() => ofType("status", each.id).at(-1)?.busy === false, "the tab to be idle");
        }

        // Still so after a reload, for the sessions to reopen with.
        yield* until(() => (context.workspaceState.get("codeAcp.tabs") as { tabs: Array<{ wanted?: unknown }> } | undefined)?.tabs.some((each) => each.wanted) === true, "the tabs to be saved");
        const restored = new TabList(context.workspaceState.get("codeAcp.tabs"), () => "/d");
        const saved = restored.all.find((each) => each.group !== undefined);
        assert.deepStrictEqual(saved!.wanted, { model: "big", effort: "high" });
        assert.strictEqual(saved!.attemptLabel, "Big · High");
        assert.strictEqual(tabsNow().groups.length, 1);
      }).pipe(Effect.scoped),
    );

    it.live("reads an attempt's options from a session on that model, and says why it can't otherwise", () =>
      Effect.gen(function* () {
        agentEnv = { MOCK_MODELS: "1" };
        const { send, ofType } = yield* startInRepo;
        send({ type: "loadAttemptOptions", agentId: "mock", model: "small" });
        yield* until(() => ofType("attemptOptions").length === 1, "the options");
        const answer = ofType("attemptOptions")[0]!;
        assert.deepStrictEqual(
          answer.options.models.map((m: { value: string }) => m.value),
          ["small", "big"],
        );
        assert.deepStrictEqual(
          answer.options.efforts.map((e: { value: string }) => e.value),
          ["low"],
        );
        // This model has no session to read, and the stub's agent isn't one the real manager can start.
        send({ type: "loadAttemptOptions", agentId: "other", model: "big" });
        yield* until(() => ofType("attemptOptions").length === 2, "the second answer");
        const failed = ofType("attemptOptions")[1]!;
        assert.isUndefined(failed.options);
        assert.isString(failed.error);
      }).pipe(Effect.scoped),
    );

    it.live("makes the worktree of a ticked box only when a message goes, and goes back from the picker", () =>
      Effect.gen(function* () {
        const { folder, ofType, say, send, tab, tabsNow, idle, context } = yield* startInRepo;
        const info = () => tabsNow().tabs.find((each) => each.id === tab)!;
        const worktreeCount = () => git(folder, "worktree", "list").trim().split("\n").length;
        yield* until(() => ofType("session", tab).length === 1, "the first session");
        send({ type: "toggleWorktree", tab });
        yield* until(() => info().worktreeOnSend === true, "the tick");
        send({ type: "toggleWorktree", tab });
        yield* until(() => !info().worktreeOnSend, "the box to clear");
        send({ type: "toggleWorktree", tab });
        yield* until(() => info().worktreeOnSend === true, "the tick");
        assert.strictEqual(worktreeCount(), 1);
        assert.isUndefined(info().worktree);
        // Still ticked after a reload.
        yield* until(() => new TabList(context.workspaceState.get("codeAcp.tabs"), () => "/d").all[0]?.worktreeOnSend === true, "the tick to be saved");
        say(tab, "updates đăng nhập");
        yield* until(() => ofType("turnEnd", tab).length === 1, "the turn");
        yield* idle(tab);
        // One session where the tab was and one in the worktree, which has its name from the start.
        assert.strictEqual(ofType("session", tab).length, 2);
        assert.strictEqual(info().worktree!.base, folder);
        assert.strictEqual(info().worktree!.branch, "code-acp/updates-dang-nhap");
        assert.isNotOk(info().worktreeOnSend);
        assert.strictEqual(ofType("userMessage", tab).length, 1);
        assert.strictEqual(worktreeCount(), 2);
        // A click on its way when the tab got there changes nothing.
        send({ type: "toggleWorktree", tab });
        answering(true);
        const { showQuickPick } = window;
        window.showQuickPick = (async (items: ReadonlyArray<{ choice?: { kind: string } }>) => items.find((item) => item.choice?.kind === "local")) as typeof window.showQuickPick;
        send({ type: "pickWorktree", tab });
        yield* until(() => info().worktree === undefined, "the tab back in the folder").pipe(
          Effect.ensuring(
            Effect.sync(() => {
              window.showQuickPick = showQuickPick;
            }),
          ),
        );
        assert.strictEqual(info().cwd, folder);
        assert.isNotOk(info().worktreeOnSend);
      }).pipe(Effect.scoped),
    );

    it.live("asks before a ticked box ends a conversation, and keeps the message and the tick when turned down", () =>
      Effect.gen(function* () {
        const { folder, ofType, say, send, tab, tabsNow, idle } = yield* startInRepo;
        const info = () => tabsNow().tabs.find((each) => each.id === tab)!;
        say(tab, "updates first");
        yield* until(() => ofType("turnEnd", tab).length === 1, "the turn");
        yield* idle(tab);
        send({ type: "toggleWorktree", tab });
        yield* until(() => info().worktreeOnSend === true, "the tick");
        const asked = answering(false);
        say(tab, "updates second");
        yield* until(() => ofType("loadComposer", tab).length === 1, "the message to come back");
        assert.strictEqual(asked.length, 1);
        assert.isUndefined(info().worktree);
        assert.strictEqual(info().worktreeOnSend, true);
        assert.strictEqual(ofType("userMessage", tab).length, 1);
        answering(true);
        say(tab, "updates second");
        yield* until(() => info().worktree !== undefined && ofType("turnEnd", tab).length === 2, "the turn in the worktree");
        assert.strictEqual(info().worktree!.base, folder);
      }).pipe(Effect.scoped),
    );

    it.live("keeps the queued messages when a ticked box starts the conversation over, and sends them in the worktree", () =>
      Effect.gen(function* () {
        const { folder, ofType, say, send, tab, tabsNow, idle } = yield* startInRepo;
        const info = () => tabsNow().tabs.find((each) => each.id === tab)!;
        say(tab, "permission");
        yield* until(() => ofType("permissionRequest", tab).length === 1, "the permission request");
        send({ type: "toggleWorktree", tab });
        yield* until(() => info().worktreeOnSend === true, "the tick");
        say(tab, "updates one");
        say(tab, "updates two");
        yield* until(() => ofType("queue", tab).at(-1)?.items.length === 2, "the queued messages");
        answering(true);
        send({ type: "permission", id: ofType("permissionRequest", tab)[0]!.id, optionId: "allow" });
        yield* until(() => ofType("userMessage", tab).length === 3 && ofType("queue", tab).at(-1)?.items.length === 0, "both messages to go");
        yield* idle(tab);
        assert.deepStrictEqual(ofType("userMessage", tab).map((m) => m.text), ["permission", "updates one", "updates two"]);
        assert.strictEqual(info().worktree!.base, folder);
      }).pipe(Effect.scoped),
    );

    it.live("names the branch of a new tab's worktree after its first prompt only", () =>
      Effect.gen(function* () {
        const { folder, ofType, say, send, tabsNow, idle } = yield* startInRepo;
        __test.setSetting("codeAcp.worktreeForNewTabs", true);
        send({ type: "newTab" });
        yield* until(() => tabsNow().tabs.length === 2, "the new tab");
        const added = tabsNow().active;
        const info = () => tabsNow().tabs.find((each) => each.id === added)!;
        yield* until(() => ofType("session", added).length === 1, "its session");
        assert.strictEqual(info().worktreeOnSend, true);
        assert.isUndefined(info().worktree);
        assert.strictEqual(git(folder, "worktree", "list").trim().split("\n").length, 1);
        say(added, "updates sửa lỗi đăng");
        yield* until(() => ofType("turnEnd", added).length === 1, "the turn");
        yield* idle(added);
        assert.strictEqual(info().worktree!.branch, "code-acp/updates-sua-loi-dang");
        assert.include(git(folder, "branch"), "code-acp/updates-sua-loi-dang");
        say(added, "updates something else");
        yield* until(() => ofType("turnEnd", added).length === 2, "the second turn");
        yield* idle(added);
        assert.strictEqual(info().worktree!.branch, "code-acp/updates-sua-loi-dang");
      }).pipe(Effect.scoped),
    );

    it.live("offers to finish a worktree with work in it, and has its agent draft the pull request", () =>
      Effect.gen(function* () {
        const { folder, root, ofType, say, send, tabsNow, idle } = yield* startInRepo;
        __test.setSetting("codeAcp.worktreeForNewTabs", true);
        send({ type: "newTab" });
        yield* until(() => tabsNow().tabs.length === 2, "the new tab");
        const added = tabsNow().active;
        const info = () => tabsNow().tabs.find((each) => each.id === added)!;
        yield* until(() => ofType("session", added).length === 1, "its session");
        say(added, "updates");
        yield* until(() => ofType("turnEnd", added).length === 1, "the turn");
        yield* idle(added);
        yield* until(() => info().finishable === false, "the worktree to be read");

        const { root: worktreeRoot, branch } = info().worktree!;
        yield* Effect.promise(() => fs.writeFile(path.join(worktreeRoot, "new.txt"), "x\n"));
        say(added, "updates");
        yield* until(() => ofType("turnEnd", added).length === 2, "the second turn");
        yield* idle(added);
        yield* until(() => info().finishable === true, "the work to show");

        const remote = path.join(root, "remote.git");
        git(root, "init", "--quiet", "--bare", remote);
        git(folder, "remote", "add", "origin", remote);
        const bin = path.join(root, "bin");
        yield* Effect.promise(async () => {
          await fs.mkdir(bin);
          await fs.writeFile(path.join(bin, "gh"), '#!/bin/sh\nif [ "$2" = "list" ]; then echo "[]"; exit 0; fi\ncat > /dev/null\necho https://example.test/pr/1\n', { mode: 0o755 });
        });
        const realPath = process.env.PATH;
        process.env.PATH = `${bin}${path.delimiter}${realPath}`;
        const { showInputBox, showQuickPick } = window;
        window.showInputBox = async () => "add new";
        window.showQuickPick = (async (items: ReadonlyArray<{ choice?: { kind: string } }>) => items.find((item) => item.choice?.kind === "pr")) as typeof window.showQuickPick;
        yield* Effect.gen(function* () {
          send({ type: "finishWorktree", tab: added });
          yield* until(() => ofType("prDraft", added).length === 1, "the draft");
          const { draft } = ofType("prDraft", added)[0]!;
          assert.strictEqual(draft.title, "The drafted title");
          assert.strictEqual(draft.body, "The drafted body");
          assert.strictEqual(ofType("userMessage", added).length, 3);
          assert.notStrictEqual(git(worktreeRoot, "log", "--format=%s").split("\n")[0], "init");
          assert.strictEqual(git(remote, "branch", "--list", branch!), "");
          send({ type: "createPr", tab: added, title: "The title", body: "The body" });
          yield* until(() => ofType("prDraft", added).some((message) => message.draft === undefined), "the draft to go");
          assert.notStrictEqual(git(remote, "branch", "--list", branch!), "");
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              window.showInputBox = showInputBox;
              window.showQuickPick = showQuickPick;
              process.env.PATH = realPath;
            }),
          ),
        );
      }).pipe(Effect.scoped),
    );

    it.live("puts the prompt back when no group comes of it", () =>
      Effect.gen(function* () {
        const { send, ofType, tab, tabsNow } = yield* startInRepo;
        send({ type: "bestOf", tab, parts: ["just one"], attempts: both.slice(0, 1) });
        yield* until(() => ofType("loadComposer", tab).length === 1, "the prompt to come back");
        // An agent uninstalled since it was picked doesn't count.
        send({ type: "bestOf", tab, parts: ["one left"], attempts: [both[0]!, { agentId: "gone", model: "", effort: "" }] });
        yield* until(() => ofType("loadComposer", tab).length === 2, "the prompt to come back");
        assert.deepStrictEqual(ofType("loadComposer", tab).map((m) => m.parts), [["just one"], ["one left"]]);
        assert.strictEqual(tabsNow().tabs.length, 1);
        assert.deepStrictEqual(tabsNow().groups, []);
      }).pipe(Effect.scoped),
    );

    it.live("won't start outside git, where the agents would share a folder", () =>
      Effect.gen(function* () {
        const { send, ofType, tab, tabsNow } = yield* startChat;
        send({ type: "bestOf", tab, parts: ["go"], attempts: both });
        yield* until(() => ofType("loadComposer", tab).length === 1, "the prompt to come back");
        assert.deepStrictEqual(tabsNow().groups, []);
      }).pipe(Effect.scoped),
    );

    it.live("never lets an agent work in the base folder when its worktree can't be made", () =>
      Effect.gen(function* () {
        const { send, ofType, tab, tabsNow, root } = yield* startChat;
        // A repository without a commit has no HEAD for a worktree to start from.
        const folder = path.join(root, "workspace");
        process.env.HOME = path.join(root, "home");
        yield* Effect.promise(() => fs.mkdir(process.env.HOME!));
        git(folder, "init", "--quiet");
        send({ type: "bestOf", tab, parts: ["go"], attempts: both });
        const members = () => tabsNow().tabs.filter((each) => each.group !== undefined);
        yield* until(() => members().length === 2 && members().every((each) => each.attempt === "failed"), "both to fail");
        for (const member of members()) {
          assert.isUndefined(member.worktree);
          assert.deepStrictEqual(ofType("session", member.id), []);
          assert.deepStrictEqual(ofType("userMessage", member.id), []);
          assert.isNotEmpty(ofType("error", member.id));
          // Theirs to send again.
          assert.deepStrictEqual(ofType("loadComposer", member.id).at(-1)!.parts, ["go"]);
        }
      }).pipe(Effect.scoped),
    );

    it.live("brings groups and their tabs back after a reload", () =>
      Effect.gen(function* () {
        const { members, started, send, context, tabsNow } = yield* startInRepo;
        yield* started("updates");
        send({ type: "renameGroup", group: members()[0]!.group!, title: "Named" });
        yield* until(() => tabsNow().groups[0]?.title === "Named", "the name");
        yield* until(() => (context.workspaceState.get("codeAcp.tabs") as { groups?: Array<{ name?: string }> } | undefined)?.groups?.[0]?.name === "Named", "the tabs to be saved");
        const restored = new TabList(context.workspaceState.get("codeAcp.tabs"), () => "/d");
        assert.strictEqual(restored.groups.length, 1);
        assert.strictEqual(restored.groups[0]!.name, "Named");
        assert.strictEqual(restored.shownGroup, restored.groups[0]);
        assert.strictEqual(restored.members(restored.groups[0]!).length, 2);
        assert.isDefined(restored.members(restored.groups[0]!)[0]!.worktree);
      }).pipe(Effect.scoped),
    );
  });
});
