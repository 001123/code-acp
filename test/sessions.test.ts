import type * as acp from "@agentclientprotocol/sdk";
import { assert, beforeEach, describe, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Scope } from "effect";
import { AgentRequestError, AuthRequiredError, type AcpAgent } from "../src/acpClient";
import { AgentPool } from "../src/chat/agents";
import { ChangeReview } from "../src/chat/changes";
import type { ChatUi } from "../src/chat/host";
import type { LastOptions } from "../src/chat/lastOptions";
import { Permissions } from "../src/chat/permissions";
import { NoAgentError, TabSessions } from "../src/chat/sessions";
import { TabList, type RunningAgent, type Tab } from "../src/chat/tabs";
import { TabTurns } from "../src/chat/turns";
import type { TabUsage } from "../src/chat/usage";
import type { TabWorktrees } from "../src/chat/worktrees";
import { __test } from "./stubs/vscode";

type RequestError = AuthRequiredError | AgentRequestError;

const requestError = new AgentRequestError({ method: "session/load", message: "no", cause: undefined });

const runFork = (effect: Effect.Effect<void, unknown, any>) => void Effect.runFork(effect as Effect.Effect<void, unknown>);

const until = (ready: () => boolean) =>
  Effect.gen(function* () {
    while (!ready()) {
      yield* Effect.sleep("1 millis");
    }
  });

const makeSessions = Effect.fnUntraced(function* (
  overrides: Partial<AcpAgent> = {},
  capabilities: acp.AgentCapabilities = {},
  noAgent = false,
) {
  const posted: Array<Record<string, unknown>> = [];
  const statuses: string[] = [];
  const created: string[] = [];
  const closed: string[] = [];
  const agent = {
    initializeResponse: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: {} }, ...capabilities } },
    newSession: () =>
      Effect.sync(() => {
        const sessionId = `new-${created.length + 1}`;
        created.push(sessionId);
        return { sessionId };
      }),
    closeSession: (sessionId: string) =>
      Effect.sync(() => {
        closed.push(sessionId);
      }),
    cancel: () => Effect.void,
    prompt: () => Effect.succeed({ stopReason: "end_turn" }),
    ...overrides,
  } as unknown as AcpAgent;
  const running: RunningAgent = { agent, agentId: "a", scope: yield* Scope.make() };
  const agents = new AgentPool();
  yield* agents.get("a", Effect.succeed(running));
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
  const changes = new ChangeReview({ postTab: ui.postTab, saveTabs: ui.saveTabs, run: () => {}, openFile: () => Effect.void });
  const usage = { postSaved: () => {}, recordTurn: () => Effect.void } as unknown as TabUsage;
  const tabWorktrees = { ensure: () => Effect.void, prepare: () => Effect.void } as unknown as TabWorktrees;
  const parts = { tabs, changes, usage, tabWorktrees };
  const turns: TabTurns = new TabTurns(
    {
      ...ui,
      ...parts,
      ensureSession: (tab) => sessions.ensureSession(tab),
      cancelTab: (tab) => sessions.cancelTab(tab),
      finished: () => {},
      turnEnded: () => {},
    },
    1,
  );
  const sessions: TabSessions = new TabSessions({
    ...ui,
    ...parts,
    agents,
    turns,
    permissions: new Permissions<Tab>({ shown: () => {}, done: () => {} }),
    lastOptions: { wanted: () => undefined } as unknown as LastOptions,
    selectTab: () => Effect.void,
    getAgent: (tab) => {
      if (noAgent) {
        return Effect.fail(new NoAgentError());
      }
      tab.agentId = running.agentId;
      return Effect.succeed(running);
    },
  });
  const run = <A, E>(effect: Effect.Effect<A, E, any>) => effect as Effect.Effect<A, E>;
  return { tabs, tab: tabs.active, sessions, turns, running, posted, statuses, created, closed, run };
});

const ofType = (posted: ReadonlyArray<Record<string, unknown>>, type: string) => posted.filter((message) => message.type === type);

beforeEach(() => __test.reset());

describe("TabSessions", () => {
  it.effect("shares one session start between concurrent callers", () =>
    Effect.gen(function* () {
      const { tab, sessions, created, run, statuses } = yield* makeSessions();
      const ids = yield* run(Effect.all([sessions.ensureSession(tab), sessions.ensureSession(tab)], { concurrency: "unbounded" }));
      assert.deepStrictEqual(ids, ["new-1", "new-1"]);
      assert.deepStrictEqual(created, ["new-1"]);
      assert.strictEqual(tab.sessionId, "new-1");
      assert.strictEqual(statuses.at(-1), "chat.ready");
    }),
  );

  it.live("frees a session whose tab closed while it started", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const { tabs, tab, sessions, closed, run } = yield* makeSessions({
        newSession: () => Deferred.await(gate).pipe(Effect.as({ sessionId: "late" })),
      });
      tabs.add("/w");
      const fiber = yield* run(sessions.ensureSession(tab)).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      tabs.remove(tab);
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.await(fiber);
      assert.deepStrictEqual(closed, ["late"]);
      assert.isUndefined(tab.sessionId);
    }),
  );

  it.effect("starts over in a fresh session when a saved one can't be reopened", () =>
    Effect.gen(function* () {
      const { tab, sessions, posted, created, run } = yield* makeSessions(
        { loadSession: () => Effect.fail(requestError) },
        { loadSession: true },
      );
      tab.title = "old";
      tab.used = true;
      tab.reopen = { sessionId: "saved", cwd: "/w", agentId: "a" };
      const id = yield* run(sessions.ensureSession(tab));
      assert.strictEqual(id, "new-1");
      assert.deepStrictEqual(created, ["new-1"]);
      assert.deepStrictEqual(ofType(posted, "notice"), [{ type: "notice", key: "chat.reopenFailed" }]);
      assert.isUndefined(tab.reopen);
      assert.isUndefined(tab.title);
      assert.isFalse(tab.used);
      assert.isFalse(tab.busy);
    }),
  );

  it.effect("keeps a saved session to reopen after the user logs in", () =>
    Effect.gen(function* () {
      const { tab, sessions, created, statuses, run } = yield* makeSessions(
        { loadSession: () => Effect.fail<RequestError>(new AuthRequiredError({ message: "login" })) },
        { loadSession: true },
      );
      tab.reopen = { sessionId: "saved", cwd: "/elsewhere", agentId: "a" };
      const before = tab.cwd;
      assert.isUndefined(yield* run(sessions.ensureSession(tab)));
      assert.strictEqual(statuses.at(-1), "chat.needsLogin");
      assert.deepStrictEqual(tab.reopen, { sessionId: "saved", cwd: "/elsewhere", agentId: "a" });
      assert.deepStrictEqual(created, []);
      assert.isUndefined(tab.sessionId);
      assert.strictEqual(tab.cwd, before);
    }),
  );

  it.live("reopens a saved session on the same agent, sending what waited in the queue", () =>
    Effect.gen(function* () {
      const prompts: string[] = [];
      const { tab, sessions, created, run } = yield* makeSessions(
        {
          loadSession: () => Effect.succeed({}),
          prompt: (sessionId) =>
            Effect.sync(() => {
              prompts.push(sessionId);
              return { stopReason: "end_turn" as const };
            }),
        },
        { loadSession: true },
      );
      tab.reopen = { sessionId: "saved", cwd: "/w/app", agentId: "a" };
      tab.queue.push({ id: 1, parts: ["waited"] });
      const id = yield* run(sessions.ensureSession(tab));
      yield* until(() => prompts.length === 1);
      assert.deepStrictEqual(prompts, ["saved"]);
      assert.strictEqual(id, "saved");
      assert.strictEqual(tab.cwd, "/w/app");
      assert.isUndefined(tab.reopen);
      assert.deepStrictEqual(created, []);
      assert.isTrue(tab.used);
      assert.strictEqual(tab.queue.length, 0);
    }),
  );

  describe("a turn whose agent went away", () => {
    /** A running turn with a message queued behind it; the first prompt fails when told to. */
    const runningTurn = Effect.gen(function* () {
      const fail = yield* Deferred.make<void>();
      const prompts: string[] = [];
      const made = yield* makeSessions({
        prompt: (sessionId) => {
          prompts.push(sessionId);
          return prompts.length === 1 ? Deferred.await(fail).pipe(Effect.andThen(Effect.fail(requestError))) : Effect.succeed({ stopReason: "end_turn" as const });
        },
      });
      const { tab, running, turns, run } = made;
      tab.sessionId = "s";
      tab.running = running;
      const turn = yield* run(turns.send(tab, { parts: ["one"] })).pipe(Effect.forkChild);
      yield* until(() => prompts.length === 1);
      yield* run(turns.send(tab, { parts: ["two"] }));
      return { ...made, fail, prompts, turn };
    });

    it.live("says nothing when a restart cut it off, and sends the queue to a session already back", () =>
      Effect.gen(function* () {
        const { tab, fail, prompts, turn } = yield* runningTurn;
        tab.turn = undefined;
        tab.busy = false;
        tab.sessionId = "back";
        yield* Deferred.succeed(fail, undefined);
        assert.isTrue(Exit.isSuccess(yield* Fiber.await(turn)));
        yield* until(() => prompts.length === 2);
        assert.deepStrictEqual(prompts, ["s", "back"]);
        assert.strictEqual(tab.queue.length, 0);
      }),
    );

    it.live("leaves the queue to the session that is still coming back", () =>
      Effect.gen(function* () {
        const { tab, fail, prompts, turn } = yield* runningTurn;
        tab.turn = undefined;
        tab.busy = false;
        tab.sessionId = undefined;
        yield* Deferred.succeed(fail, undefined);
        assert.isTrue(Exit.isSuccess(yield* Fiber.await(turn)));
        assert.deepStrictEqual(prompts, ["s"]);
        assert.strictEqual(tab.queue.length, 1);
        assert.isFalse(tab.steer);
      }),
    );

    it.live("reports the failure when the agent died on its own", () =>
      Effect.gen(function* () {
        const { tab, fail, prompts, turn } = yield* runningTurn;
        yield* Deferred.succeed(fail, undefined);
        assert.isTrue(Exit.isFailure(yield* Fiber.await(turn)));
        assert.deepStrictEqual(prompts, ["s"]);
        assert.strictEqual(tab.queue.length, 1);
      }),
    );
  });

  it.effect("starts over: frees the old session and applies the change", () =>
    Effect.gen(function* () {
      const { tab, sessions, created, closed, posted, running, run } = yield* makeSessions();
      tab.sessionId = "old";
      tab.running = running;
      tab.used = true;
      tab.usage = { used: 1, size: 2 };
      tab.usageSessionId = "old";
      yield* run(sessions.startOver(tab, (each) => (each.cwd = "/w/other")));
      assert.deepStrictEqual(closed, ["old"]);
      assert.deepStrictEqual(created, ["new-1"]);
      assert.strictEqual(tab.sessionId, "new-1");
      assert.isUndefined(tab.usage);
      assert.isFalse(tab.used);
      assert.strictEqual(ofType(posted, "reset").length, 1);
    }),
  );

  it.effect("doesn't ask before starting over a tab with nothing to lose", () =>
    Effect.gen(function* () {
      const { tab, sessions, run } = yield* makeSessions();
      assert.isTrue(yield* run(sessions.confirmStartOver(tab)));
    }),
  );

  it.effect("forks a conversation back to before a user message, into a tab beside it", () =>
    Effect.gen(function* () {
      const { tabs, tab, sessions, running, posted, run } = yield* makeSessions(
        { forkSession: () => Effect.succeed({ sessionId: "forked" }) },
        { sessionCapabilities: { close: {}, fork: {} } } as acp.AgentCapabilities,
      );
      const other = tabs.add("/w");
      tab.sessionId = "s";
      tab.running = running;
      tab.title = "Work";
      tab.sent.set(1, { parts: ["one"] });
      tab.sent.set(2, { parts: ["two"] });
      yield* run(sessions.fork(tab, 2));
      const fork = tabs.active;
      assert.notStrictEqual(fork, tab);
      assert.strictEqual(tabs.indexOf(fork), tabs.indexOf(tab) + 1);
      assert.strictEqual(tabs.indexOf(other), tabs.indexOf(fork) + 1);
      assert.strictEqual(fork.sessionId, "forked");
      assert.deepStrictEqual([...fork.sent.keys()], [1]);
      assert.deepStrictEqual([...tab.sent.keys()], [1, 2]);
      assert.include(fork.rewindNote!, '"two"');
      assert.isUndefined(tab.rewindNote);
      assert.deepStrictEqual(ofType(posted, "loadComposer"), [{ type: "loadComposer", parts: ["two"] }]);
    }),
  );

  it.effect("frees a fork whose tab closed meanwhile", () =>
    Effect.gen(function* () {
      const { tabs, tab, sessions, running, closed, run } = yield* makeSessions(
        {
          forkSession: () =>
            Effect.sync(() => {
              tabs.remove(tab);
              return { sessionId: "forked" };
            }),
        },
        { sessionCapabilities: { close: {}, fork: {} } } as acp.AgentCapabilities,
      );
      tabs.add("/w");
      tab.sessionId = "s";
      tab.running = running;
      yield* run(sessions.fork(tab, undefined));
      assert.deepStrictEqual(closed, ["forked"]);
      assert.strictEqual(tabs.length, 1);
    }),
  );

  it.effect("says the agent is missing rather than failing", () =>
    Effect.gen(function* () {
      const { tab, statuses, run, sessions } = yield* makeSessions({}, {}, true);
      assert.isUndefined(yield* run(sessions.ensureSession(tab)));
      assert.strictEqual(statuses.at(-1), "chat.noAgent");
    }),
  );
});
