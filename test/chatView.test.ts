import { assert, beforeEach, describe, it } from "@effect/vitest";
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
import { __test, EventEmitter, Uri, workspace } from "./stubs/vscode";

const MOCK_AGENT = fileURLToPath(new URL("./fixtures/mock-agent.mjs", import.meta.url));

type Posted = Record<string, any>;

const memento = (values = new Map<string, unknown>()) =>
  ({
    get: (key: string, fallback?: unknown) => (values.has(key) ? values.get(key) : fallback),
    update: async (key: string, value: unknown) => void values.set(key, value),
    keys: () => [...values.keys()],
  }) as unknown as vscode.Memento;

const manager = {
  onDidChange: new EventEmitter<void>().event,
  agents: Effect.succeed([{ id: "mock", name: "Mock" }]),
  has: (id: string) => Effect.succeed(id === "mock"),
  command: () => Effect.succeed({ command: process.execPath, args: [MOCK_AGENT], env: { ...process.env, MOCK_FORK: "1" } }),
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
    return { root, runtime, provider, posted, send: (message: FromWebview) => receive(message) };
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

beforeEach(() => __test.reset());

describe("ChatViewProvider", () => {
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
