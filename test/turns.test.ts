import type * as acp from "@agentclientprotocol/sdk";
import { assert, beforeEach, describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Scope } from "effect";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentStartError, AuthRequiredError, type AcpAgent } from "../src/acpClient";
import { ChangeReview } from "../src/chat/changes";
import type { ChatUi } from "../src/chat/host";
import type { TurnMessage } from "../src/chat/protocol";
import { TabList, type Tab } from "../src/chat/tabs";
import { TabTurns, type TurnsHost } from "../src/chat/turns";
import type { TabUsage } from "../src/chat/usage";
import type { TabWorktrees } from "../src/chat/worktrees";
import { __test } from "./stubs/vscode";

type Reply = Deferred.Deferred<acp.PromptResponse, AuthRequiredError>;

const textsOf = (prompt: ReadonlyArray<acp.ContentBlock>) =>
  prompt.flatMap((block) => (block.type === "text" ? [block.text] : []));

const runFork = (effect: Effect.Effect<void, unknown, any>) =>
  void Effect.runFork(effect as Effect.Effect<void, unknown>);

const until = (ready: () => boolean) =>
  Effect.gen(function* () {
    while (!ready()) {
      yield* Effect.sleep("1 millis");
    }
  });

/** The turns of one tab with a session on an agent that answers each prompt when told to. */
const makeTurns = Effect.fnUntraced(function* (
  ensureSession: TurnsHost["ensureSession"] = (each) => Effect.succeed(each.sessionId),
) {
  const posted: Array<Record<string, unknown>> = [];
  const statuses: string[] = [];
  const finished: Tab[] = [];
  const ended: Tab[] = [];
  const prompts: Array<{ texts: string[]; reply: Reply }> = [];
  let cancelled = 0;
  const agent = {
    initializeResponse: { protocolVersion: 1, agentCapabilities: {} },
    prompt: (_sessionId: string, prompt: Array<acp.ContentBlock>) =>
      Effect.gen(function* () {
        const reply: Reply = yield* Deferred.make<acp.PromptResponse, AuthRequiredError>();
        prompts.push({ texts: textsOf(prompt), reply });
        return yield* Deferred.await(reply);
      }),
  } as unknown as AcpAgent;
  const ui: ChatUi = {
    postTab: (_tab, message) => void posted.push(message),
    postTabs: () => {},
    status: (_tab, key) => void statuses.push(key),
    refreshStatus: () => {},
    saveTabs: () => {},
    setConfigOptions: () => {},
    run: (effect) => runFork(effect),
  };
  const tabs = new TabList(undefined, () => "/w");
  const tab = tabs.active;
  tab.sessionId = "s";
  tab.running = { agent, agentId: "a", scope: yield* Scope.make() };
  const turns = new TabTurns(
    {
      ...ui,
      tabs,
      changes: new ChangeReview({
        postTab: ui.postTab,
        saveTabs: ui.saveTabs,
        run: () => {},
        openFile: () => Effect.void,
      }),
      usage: { recordTurn: () => Effect.void, totals: () => Effect.succeed({ turns: 7 }) } as unknown as TabUsage,
      tabWorktrees: {
        localize: (_tab: Tab, attachment: unknown) => Effect.succeed(attachment),
        nameAfter: () => Effect.void,
      } as unknown as TabWorktrees,
      ensureSession,
      cancelTab: () =>
        Effect.sync(() => {
          cancelled++;
        }),
      finished: (each) => void finished.push(each),
      turnEnded: (each) => void ended.push(each),
    },
    1,
  );
  const send = (msg: TurnMessage) => runFork(turns.onMessage(tab, msg));
  const say = (text: string, options: { now?: boolean; rewind?: number } = {}) =>
    send({ type: "send", tab: tab.id, parts: [text], ...options });
  const answer = (index: number, stopReason: acp.StopReason = "end_turn") =>
    Deferred.succeed(prompts[index]!.reply, { stopReason }).pipe(
      Effect.andThen(until(() => !tab.busy || prompts.length > index + 1)),
    );
  // The fakes above need no services.
  const ask = (text: string) => turns.ask(tab, text) as Effect.Effect<string | undefined, unknown>;
  return {
    tab,
    tabs,
    turns,
    posted,
    statuses,
    finished,
    ended,
    prompts,
    send,
    say,
    ask,
    answer,
    cancelled: () => cancelled,
  };
});

const ofType = (posted: ReadonlyArray<Record<string, unknown>>, type: string) =>
  posted.filter((message) => message.type === type);

beforeEach(() => __test.reset());

describe("TabTurns", () => {
  it.live(
    "gives whoever asked the agent's last message once the turn finished, and shows the turn like any other",
    () =>
      Effect.gen(function* () {
        const { tab, ask, prompts, answer, posted } = yield* makeTurns();
        const fiber = yield* Effect.forkChild(ask("write it"));
        yield* until(() => prompts.length === 1);
        assert.deepStrictEqual(prompts[0]!.texts, ["write it"]);
        assert.strictEqual(ofType(posted, "userMessage").length, 1);
        tab.reply!.text = "The reply";
        yield* answer(0);
        assert.strictEqual(yield* Fiber.join(fiber), "The reply");
        assert.isUndefined(tab.reply);
        assert.isFalse(tab.sending);
      }),
  );

  it.live("gives nothing for a turn that was stopped, or a tab that is busy", () =>
    Effect.gen(function* () {
      const { ask, prompts, answer } = yield* makeTurns();
      const fiber = yield* Effect.forkChild(ask("write it"));
      yield* until(() => prompts.length === 1);
      assert.isUndefined(yield* ask("another"));
      assert.strictEqual(prompts.length, 1);
      yield* answer(0, "cancelled");
      assert.isUndefined(yield* Fiber.join(fiber));
    }),
  );

  it.live("leaves the composer alone when there is no session to ask", () =>
    Effect.gen(function* () {
      const { ask, prompts, posted } = yield* makeTurns(() => Effect.undefined);
      assert.isUndefined(yield* ask("write it"));
      assert.strictEqual(prompts.length, 0);
      assert.deepStrictEqual(ofType(posted, "loadComposer"), []);
    }),
  );

  it.live("posts the numbers of a finished turn only while tracing is on", () =>
    Effect.gen(function* () {
      const { say, answer, prompts, posted, tab } = yield* makeTurns();
      say("first");
      yield* until(() => prompts.length === 1);
      yield* answer(0);
      assert.deepStrictEqual(ofType(posted, "turnTrace"), []);
      __test.setSetting("codeAcp.tracing", true);
      say("second");
      yield* until(() => prompts.length === 2);
      yield* answer(1, "max_tokens");
      const traces = ofType(posted, "turnTrace") as Array<{
        trace: { stopReason: string; sessionId: string; durationMs: number };
      }>;
      assert.strictEqual(traces.length, 1);
      assert.strictEqual(traces[0]!.trace.stopReason, "max_tokens");
      assert.strictEqual(traces[0]!.trace.sessionId, "s");
      assert.isAtLeast(traces[0]!.trace.durationMs, 0);
      assert.strictEqual((traces[0]!.trace as unknown as { number: number }).number, 7);
      // Kept for a reload, under the position of its message: the first turn counted too.
      assert.deepStrictEqual(
        tab.traces.saved?.traces.map((each) => [each.message, each.trace.stopReason]),
        [[1, "max_tokens"]],
      );
    }),
  );

  it.live("counts what the agent does during the running turn only", () =>
    Effect.gen(function* () {
      __test.setSetting("codeAcp.tracing", true);
      const { say, answer, prompts, posted, tab } = yield* makeTurns();
      tab.turnStats?.onUpdate({ sessionUpdate: "tool_call", toolCallId: "before", title: "t" });
      say("first");
      yield* until(() => prompts.length === 1);
      tab.turnStats!.onUpdate({ sessionUpdate: "tool_call", toolCallId: "a", title: "t", kind: "read" });
      yield* answer(0);
      assert.isUndefined(tab.turnStats);
      const [{ trace }] = ofType(posted, "turnTrace") as unknown as Array<{ trace: { tools: unknown } }>;
      assert.deepStrictEqual(trace.tools, { total: 1, failed: 0, kinds: { read: 1 } });
    }),
  );

  it.live("ignores a message with nothing in it", () =>
    Effect.gen(function* () {
      const { say, prompts, tab } = yield* makeTurns();
      say("  \n");
      yield* Effect.sleep("5 millis");
      assert.strictEqual(prompts.length, 0);
      assert.isFalse(tab.used);
    }),
  );

  it.live("titles the tab after the first line of its first message", () =>
    Effect.gen(function* () {
      const { say, prompts, tab } = yield* makeTurns();
      say(`${"x".repeat(50)}\nmore`);
      yield* until(() => prompts.length === 1);
      assert.strictEqual(tab.title, `${"x".repeat(39)}…`);
      assert.isTrue(tab.busy);
      assert.isTrue(tab.used);
    }),
  );

  it.live("queues what is sent during a turn and sends it when the turn ends", () =>
    Effect.gen(function* () {
      const { say, prompts, tab, answer, finished, posted } = yield* makeTurns();
      say("first");
      yield* until(() => prompts.length === 1);
      say("second");
      say("third");
      yield* until(() => tab.queue.length === 2);
      yield* answer(0);
      yield* until(() => prompts.length === 2);
      assert.deepStrictEqual(prompts[1]!.texts, ["second"]);
      assert.deepStrictEqual(
        tab.queue.map((each) => each.parts),
        [["third"]],
      );
      // The queue follows, so this is not the end yet.
      assert.deepStrictEqual(finished, []);
      assert.deepStrictEqual(ofType(posted, "queue").at(-1)?.items, [{ id: 2, text: "third", attachments: [] }]);
      yield* answer(1);
      yield* until(() => prompts.length === 3);
      yield* answer(2);
      yield* until(() => finished.length === 1);
      assert.isFalse(tab.busy);
    }),
  );

  it.live("keeps the queue after a turn the user stopped", () =>
    Effect.gen(function* () {
      const { say, prompts, tab, answer, finished, ended } = yield* makeTurns();
      say("first");
      yield* until(() => prompts.length === 1);
      say("second");
      yield* until(() => tab.queue.length === 1);
      yield* answer(0, "cancelled");
      yield* until(() => ended.length === 1);
      yield* Effect.sleep("5 millis");
      assert.strictEqual(prompts.length, 1);
      assert.strictEqual(tab.queue.length, 1);
      assert.deepStrictEqual(finished, []);
    }),
  );

  it.live("stops the running turn for a message sent now, ahead of the queue", () =>
    Effect.gen(function* () {
      const { say, prompts, tab, answer, cancelled } = yield* makeTurns();
      say("first");
      yield* until(() => prompts.length === 1);
      say("queued");
      yield* until(() => tab.queue.length === 1);
      say("urgent", { now: true });
      yield* until(() => cancelled() === 1);
      assert.isTrue(tab.steer);
      yield* answer(0, "cancelled");
      yield* until(() => prompts.length === 2);
      assert.deepStrictEqual(prompts[1]!.texts, ["urgent"]);
      assert.isFalse(tab.steer);
      assert.deepStrictEqual(
        tab.queue.map((each) => each.parts),
        [["queued"]],
      );
    }),
  );

  it.live("gives a queued message back to the composer to edit", () =>
    Effect.gen(function* () {
      const { say, send, prompts, tab, posted } = yield* makeTurns();
      say("first");
      yield* until(() => prompts.length === 1);
      say("second");
      yield* until(() => tab.queue.length === 1);
      send({ type: "unqueue", tab: tab.id, id: tab.queue[0]!.id, edit: true });
      yield* until(() => tab.queue.length === 0);
      assert.deepStrictEqual(ofType(posted, "loadComposer"), [{ type: "loadComposer", parts: ["second"] }]);
    }),
  );

  it.live("takes back an edited message and what followed, telling the agent once", () =>
    Effect.gen(function* () {
      const { say, prompts, tab, answer, posted } = yield* makeTurns();
      say("one");
      yield* until(() => prompts.length === 1);
      yield* answer(0);
      say("two");
      yield* until(() => prompts.length === 2);
      yield* answer(1);
      const [first, second] = [...tab.sent.keys()];
      say("two, edited", { rewind: second! });
      yield* until(() => prompts.length === 3);
      assert.deepStrictEqual(ofType(posted, "rewind"), [{ type: "rewind", turn: second }]);
      assert.strictEqual(prompts[2]!.texts.length, 2);
      assert.include(prompts[2]!.texts[0]!, 'took back their message "two"');
      assert.strictEqual(prompts[2]!.texts[1], "two, edited");
      assert.isFalse(tab.sent.has(second!));
      assert.isTrue(tab.sent.has(first!));
      yield* answer(2);
      say("three");
      yield* until(() => prompts.length === 4);
      assert.deepStrictEqual(prompts[3]!.texts, ["three"]);
    }),
  );

  it.live("gives an edit back to the composer while a turn runs", () =>
    Effect.gen(function* () {
      const { say, prompts, tab, posted } = yield* makeTurns();
      say("one");
      yield* until(() => prompts.length === 1);
      const [turn] = [...tab.sent.keys()];
      say("edited", { rewind: turn! });
      yield* until(() => ofType(posted, "loadComposer").length === 1);
      assert.deepStrictEqual(ofType(posted, "loadComposer"), [
        { type: "loadComposer", parts: ["edited"], rewind: turn },
      ]);
      assert.deepStrictEqual(ofType(posted, "rewind"), []);
      assert.strictEqual(prompts.length, 1);
    }),
  );

  it.live("sends the message of a turn again on retry, and says so when it can't", () =>
    Effect.gen(function* () {
      const { say, send, prompts, tab, answer, posted } = yield* makeTurns();
      say("one");
      yield* until(() => prompts.length === 1);
      yield* answer(0);
      const [turn] = [...tab.sent.keys()];
      send({ type: "retry", tab: tab.id, turn: turn! + 100 });
      yield* until(() => ofType(posted, "notice").length === 1);
      send({ type: "retry", tab: tab.id, turn: turn! });
      yield* until(() => prompts.length === 2);
      assert.strictEqual(prompts[1]!.texts.at(-1), "one");
    }),
  );

  it.live("shows sent attachments with where they open", () =>
    Effect.gen(function* () {
      const { send, tab, posted } = yield* makeTurns();
      const file = path.join(yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "turns-"))), "open.ts");
      yield* Effect.promise(() => fs.writeFile(file, "text"));
      const parts = [
        "look ",
        { kind: "uri" as const, uri: `file://${file}`, name: "open.ts", token: "@open.ts" },
        " ",
        {
          kind: "snippet" as const,
          uri: `file://${file}`,
          name: "open.ts:2-3",
          languageId: "ts",
          startLine: 2,
          endLine: 3,
          text: "selected",
          token: "@open.ts:2-3",
        },
      ];
      send({ type: "send", tab: tab.id, parts });
      yield* until(() => ofType(posted, "userMessage").length === 1);
      const shown = ofType(posted, "userMessage")[0]!;
      assert.strictEqual(shown.text, "look @open.ts @open.ts:2-3");
      assert.deepStrictEqual(
        (shown.attachments as Array<{ name: string; token?: string; path?: string; line?: number }>).map((a) => [
          a.name,
          a.token,
          a.path,
          a.line,
        ]),
        [
          ["open.ts", "@open.ts", file, undefined],
          ["open.ts:2-3", "@open.ts:2-3", file, 2],
        ],
      );
    }),
  );

  it.live("asks for a login when the agent wants one, leaving the queue", () =>
    Effect.gen(function* () {
      const { say, prompts, tab, statuses, finished, ended } = yield* makeTurns();
      say("one");
      yield* until(() => prompts.length === 1);
      say("two");
      yield* until(() => tab.queue.length === 1);
      yield* Deferred.fail(prompts[0]!.reply, new AuthRequiredError({ message: "login" }));
      yield* until(() => ended.length === 1);
      assert.isUndefined(tab.sessionId);
      assert.strictEqual(statuses.at(-1), "chat.needsLogin");
      assert.strictEqual(tab.queue.length, 1);
      assert.deepStrictEqual(finished, []);
    }),
  );

  describe("a message whose turn can't start", () => {
    it.live("goes back to the composer when the user has to act first", () =>
      Effect.gen(function* () {
        const { say, posted, prompts, tab, finished } = yield* makeTurns();
        tab.sessionId = undefined;
        say("hello");
        yield* until(() => ofType(posted, "loadComposer").length === 1);
        assert.deepStrictEqual(ofType(posted, "loadComposer"), [{ type: "loadComposer", parts: ["hello"] }]);
        assert.deepStrictEqual(ofType(posted, "userMessage"), []);
        assert.strictEqual(prompts.length, 0);
        assert.isFalse(tab.sending);
        assert.isFalse(tab.used);
        assert.deepStrictEqual(finished, []);
      }),
    );

    it.live("goes back to the composer when the agent fails to start", () =>
      Effect.gen(function* () {
        const { say, posted, tab } = yield* makeTurns(() => Effect.fail(new AgentStartError({ message: "no" })));
        say("hello");
        yield* until(() => ofType(posted, "loadComposer").length === 1);
        assert.deepStrictEqual(ofType(posted, "loadComposer"), [{ type: "loadComposer", parts: ["hello"] }]);
        assert.isFalse(tab.sending);
      }),
    );

    it.live("keeps its attachments", () =>
      Effect.gen(function* () {
        const { send, posted, tab } = yield* makeTurns();
        tab.sessionId = undefined;
        const attachment = { kind: "uri" as const, uri: "file:///w/a.ts", name: "a.ts", token: "@a.ts" };
        send({ type: "send", tab: tab.id, parts: ["see ", attachment] });
        yield* until(() => ofType(posted, "loadComposer").length === 1);
        assert.deepStrictEqual(ofType(posted, "loadComposer")[0]!.parts, ["see ", attachment]);
      }),
    );

    it.live("goes back when its only attachment can't be read", () =>
      Effect.gen(function* () {
        const { send, posted, prompts, tab } = yield* makeTurns();
        const missing = { kind: "uri" as const, uri: "file:///nonexistent/gone.ts", name: "gone.ts" };
        send({ type: "send", tab: tab.id, parts: [missing] });
        yield* until(() => ofType(posted, "loadComposer").length === 1);
        assert.deepStrictEqual(ofType(posted, "loadComposer")[0]!.parts, [missing]);
        assert.strictEqual(ofType(posted, "error").length, 1);
        assert.strictEqual(prompts.length, 0);
      }),
    );

    it.live("goes back after an edit took the original away", () =>
      Effect.gen(function* () {
        const { say, prompts, tab, answer, posted } = yield* makeTurns();
        say("one");
        yield* until(() => prompts.length === 1);
        yield* answer(0);
        const [turn] = [...tab.sent.keys()];
        tab.sessionId = undefined;
        say("edited", { rewind: turn! });
        yield* until(() => ofType(posted, "loadComposer").length === 1);
        assert.deepStrictEqual(ofType(posted, "rewind"), [{ type: "rewind", turn }]);
        // The original is gone, so this is a new message and not an edit of it.
        assert.deepStrictEqual(ofType(posted, "loadComposer"), [{ type: "loadComposer", parts: ["edited"] }]);
      }),
    );

    it.live("leaves the queue waiting", () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<string | undefined>();
        const { say, posted, prompts, tab } = yield* makeTurns(() => Deferred.await(started));
        say("first");
        yield* until(() => tab.sending);
        say("second");
        yield* until(() => tab.queue.length === 1);
        yield* Deferred.succeed(started, undefined);
        yield* until(() => ofType(posted, "loadComposer").length === 1);
        assert.deepStrictEqual(ofType(posted, "loadComposer"), [{ type: "loadComposer", parts: ["first"] }]);
        assert.strictEqual(tab.queue.length, 1);
        assert.strictEqual(prompts.length, 0);
      }),
    );

    it.live("does not go back once the turn started and the agent asks for a login", () =>
      Effect.gen(function* () {
        const { say, prompts, posted, ended } = yield* makeTurns();
        say("one");
        yield* until(() => prompts.length === 1);
        yield* Deferred.fail(prompts[0]!.reply, new AuthRequiredError({ message: "login" }));
        yield* until(() => ended.length === 1);
        yield* Effect.sleep("5 millis");
        assert.deepStrictEqual(ofType(posted, "loadComposer"), []);
        assert.strictEqual(ofType(posted, "userMessage").length, 1);
      }),
    );
  });

  it.live("leaves a newer turn alone when a cancelled one ends late", () =>
    Effect.gen(function* () {
      const { say, prompts, tab, ended } = yield* makeTurns();
      say("one");
      yield* until(() => prompts.length === 1);
      tab.turn = 999;
      yield* Deferred.succeed(prompts[0]!.reply, { stopReason: "cancelled" });
      yield* Effect.sleep("5 millis");
      assert.isTrue(tab.busy);
      assert.deepStrictEqual(ended, []);
    }),
  );
});
