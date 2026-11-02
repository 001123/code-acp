import type * as acp from "@agentclientprotocol/sdk";
import { assert, beforeEach, describe, it } from "@effect/vitest";
import { Deferred, Effect, Scope } from "effect";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthRequiredError, type AcpAgent } from "../src/acpClient";
import { ChangeReview } from "../src/chat/changes";
import type { ChatUi } from "../src/chat/host";
import type { TurnMessage } from "../src/chat/protocol";
import { TabList, type Tab } from "../src/chat/tabs";
import { TabTurns } from "../src/chat/turns";
import type { TabUsage } from "../src/chat/usage";
import type { TabWorktrees } from "../src/chat/worktrees";
import { __test, Uri, window } from "./stubs/vscode";

type Reply = Deferred.Deferred<acp.PromptResponse, AuthRequiredError>;

const textsOf = (prompt: ReadonlyArray<acp.ContentBlock>) => prompt.flatMap((block) => (block.type === "text" ? [block.text] : []));

const runFork = (effect: Effect.Effect<void, unknown, any>) => void Effect.runFork(effect as Effect.Effect<void, unknown>);

const until = (ready: () => boolean) =>
  Effect.gen(function* () {
    while (!ready()) {
      yield* Effect.sleep("1 millis");
    }
  });

/** The turns of one tab with a session on an agent that answers each prompt when told to. */
const makeTurns = Effect.fnUntraced(function* () {
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
      changes: new ChangeReview({ postTab: ui.postTab, saveTabs: ui.saveTabs, run: () => {}, openFile: () => Effect.void }),
      usage: { recordTurn: () => Effect.void } as unknown as TabUsage,
      tabWorktrees: { localize: (_tab: Tab, attachment: unknown) => Effect.succeed(attachment) } as unknown as TabWorktrees,
      ensureSession: (each) => Effect.succeed(each.sessionId),
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
    Deferred.succeed(prompts[index]!.reply, { stopReason }).pipe(Effect.andThen(until(() => !tab.busy || prompts.length > index + 1)));
  return { tab, tabs, turns, posted, statuses, finished, ended, prompts, send, say, answer, cancelled: () => cancelled };
});

const ofType = (posted: ReadonlyArray<Record<string, unknown>>, type: string) => posted.filter((message) => message.type === type);

beforeEach(() => __test.reset());

describe("TabTurns", () => {
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
      assert.deepStrictEqual(tab.queue.map((each) => each.parts), [["third"]]);
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
      assert.deepStrictEqual(tab.queue.map((each) => each.parts), [["queued"]]);
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
      assert.deepStrictEqual(ofType(posted, "loadComposer"), [{ type: "loadComposer", parts: ["edited"], rewind: turn }]);
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

  /** Opens `path` with `selection` selected, as lines counted from 0. */
  const openEditor = (path: string, selection?: { from: number; to: number }) => {
    const empty = { isEmpty: true, start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
    window.activeTextEditor = {
      document: { uri: Uri.file(path), languageId: "ts", getText: () => "selected" },
      selections: [
        selection ? { isEmpty: false, start: { line: selection.from, character: 0 }, end: { line: selection.to, character: 1 } } : empty,
      ],
    } as unknown as typeof window.activeTextEditor;
  };

  it.live("adds the open file and its selected lines when the message asks for them", () =>
    Effect.gen(function* () {
      const { send, tab, posted, prompts } = yield* makeTurns();
      const file = path.join(yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "turns-"))), "open.ts");
      yield* Effect.promise(() => fs.writeFile(file, "text"));
      openEditor(file, { from: 1, to: 2 });
      send({ type: "send", tab: tab.id, parts: ["look"], includeActiveFile: true });
      yield* until(() => ofType(posted, "userMessage").length === 1);
      assert.deepStrictEqual([...tab.sent.values()][0]!.parts, [
        "look",
        { kind: "uri", uri: `file://${file}`, name: "open.ts" },
        { kind: "snippet", uri: `file://${file}`, name: "open.ts:2-3", languageId: "ts", startLine: 2, endLine: 3, text: "selected" },
      ]);
      assert.deepStrictEqual(
        (ofType(posted, "userMessage")[0]!.attachments as Array<{ name: string }>).map((a) => a.name),
        ["open.ts", "open.ts:2-3"],
      );
      assert.deepStrictEqual(ofType(posted, "error"), []);
      assert.strictEqual(prompts.length, 1);
      assert.include(prompts[0]!.texts.at(-1)!, "selected");
    }),
  );

  it.live("keeps the file that was open when a queued message was sent", () =>
    Effect.gen(function* () {
      const { say, send, tab, prompts } = yield* makeTurns();
      say("one");
      yield* until(() => prompts.length === 1);
      openEditor("/w/then.ts");
      send({ type: "send", tab: tab.id, parts: ["two"], includeActiveFile: true });
      yield* until(() => tab.queue.length === 1);
      openEditor("/w/now.ts");
      assert.deepStrictEqual(tab.queue[0]!.parts, ["two", { kind: "uri", uri: "file:///w/then.ts", name: "then.ts" }]);
    }),
  );

  it.live("does not add a file the message already holds, or one that is not asked for", () =>
    Effect.gen(function* () {
      const { say, send, tab, prompts } = yield* makeTurns();
      say("one");
      yield* until(() => prompts.length === 1);
      openEditor("/w/open.ts");
      const held = { kind: "uri" as const, uri: "file:///w/open.ts", name: "open.ts", token: "@open.ts" };
      send({ type: "send", tab: tab.id, parts: ["two ", held], includeActiveFile: true });
      say("three");
      yield* until(() => tab.queue.length === 2);
      assert.deepStrictEqual(tab.queue[0]!.parts, ["two ", held]);
      assert.deepStrictEqual(tab.queue[1]!.parts, ["three"]);
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
