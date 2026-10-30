import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { decodeBlocks, decodeDaily, decodeSessions, decodeUnified, isLockedError, toView } from "../src/ccusage";

// Trimmed from what ccusage 20 prints for Claude Code and Codex.
const claudeDaily = JSON.stringify({
  daily: [
    {
      date: "2026-10-30",
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 300,
      cacheCreationTokens: 40,
      totalTokens: 370,
      totalCost: 1.5,
      modelsUsed: ["claude-opus-5-5", "claude-haiku-5-5"],
      modelBreakdowns: [
        { modelName: "claude-opus-5-5", inputTokens: 8, outputTokens: 15, cacheReadTokens: 300, cacheCreationTokens: 40, cost: 1.4 },
        { modelName: "claude-haiku-5-5", inputTokens: 2, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0, cost: 0.1 },
      ],
    },
    {
      date: "2026-10-31",
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 3,
      totalCost: 0.5,
      modelBreakdowns: [{ modelName: "claude-opus-5-5", inputTokens: 1, outputTokens: 2, cost: 0.5 }],
    },
  ],
  totals: { totalCost: 2 },
});

const claudeSessions = JSON.stringify({
  sessions: [
    {
      sessionId: "old",
      projectPath: "-Users-me-app",
      firstActivity: "2026-10-30T08:00:00.000Z",
      lastActivity: "2026-10-30T09:00:00.000Z",
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      totalCost: 0.2,
      modelBreakdowns: [{ modelName: "claude-opus-5-5", inputTokens: 1, outputTokens: 1, cost: 0.2 }],
    },
    {
      sessionId: "new",
      lastActivity: "2026-10-31T09:00:00.000Z",
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      totalCost: 0.3,
    },
  ],
});

const claudeBlocks = JSON.stringify({
  blocks: [
    {
      id: "2026-10-31T05:00:00.000Z",
      isActive: true,
      isGap: false,
      startTime: "2026-10-31T05:00:00.000Z",
      endTime: "2026-10-31T10:00:00.000Z",
      costUSD: 3,
      totalTokens: 1000,
      models: ["claude-opus-5-5"],
      burnRate: { costPerHour: 1.2, tokensPerMinute: 10 },
      projection: { remainingMinutes: 60, totalCost: 4.2, totalTokens: 1400 },
    },
  ],
});

const codexDaily = JSON.stringify({
  daily: [
    {
      date: "2026-10-31",
      inputTokens: 100,
      outputTokens: 10,
      reasoningOutputTokens: 4,
      cacheReadTokens: 50,
      cacheCreationTokens: 0,
      totalTokens: 160,
      costUSD: 0.25,
      models: { "gpt-6.1-sol": { inputTokens: 100, outputTokens: 10, reasoningOutputTokens: 4, totalTokens: 160, isFallback: false } },
    },
  ],
});

describe("toView", () => {
  it.effect("sums Claude Code's reports by period, model and session", () =>
    Effect.gen(function* () {
      const view = toView(
        "claude",
        yield* decodeDaily(claudeDaily),
        yield* decodeSessions(claudeSessions),
        yield* decodeBlocks(claudeBlocks),
        "2026-10-31",
        "2026-10-25",
        "2026-10-02",
      );
      assert.deepStrictEqual(
        view.days.map((d) => d.day),
        ["2026-10-31", "2026-10-30"],
      );
      assert.strictEqual(view.today.cost, 0.5);
      assert.strictEqual(view.week.cost, 2);
      assert.strictEqual(view.all.tokens.total, 373);
      assert.strictEqual(view.all.tokens.cachedWrite, 40);
      assert.deepStrictEqual(
        view.models.map((m) => [m.name, m.cost]),
        [
          ["claude-opus-5-5", 1.9],
          ["claude-haiku-5-5", 0.1],
        ],
      );
      assert.deepStrictEqual(
        view.sessions.map((s) => s.id),
        ["new", "old"],
      );
      assert.strictEqual(view.sessions[1]!.project, "-Users-me-app");
      assert.deepStrictEqual(view.sessions[1]!.models, ["claude-opus-5-5"]);
      assert.strictEqual(view.block?.cost, 3);
      assert.strictEqual(view.block?.projectedCost, 4.2);
      assert.strictEqual(view.block?.end, Date.parse("2026-10-31T10:00:00.000Z"));
    }),
  );

  it.effect("reads Codex's cost and models, which have no cost by model", () =>
    Effect.gen(function* () {
      const view = toView(
        "codex",
        yield* decodeDaily(codexDaily),
        yield* decodeSessions(JSON.stringify({ sessions: [] })),
        undefined,
        "2026-10-31",
        "2026-10-25",
        "2026-10-02",
      );
      assert.strictEqual(view.today.cost, 0.25);
      assert.strictEqual(view.today.tokens.thought, 4);
      assert.deepStrictEqual(view.models, [
        {
          name: "gpt-6.1-sol",
          tokens: { input: 100, output: 10, cachedRead: 0, cachedWrite: 0, thought: 4, total: 160 },
          cost: undefined,
        },
      ]);
      assert.strictEqual(view.block, undefined);
    }),
  );

  it.effect("reads the report of all agents, with totals by agent", () =>
    Effect.gen(function* () {
      const [daily, sessions] = yield* decodeUnified(
        JSON.stringify({
          daily: [{ agent: "all", period: "2026-10-31", inputTokens: 5, outputTokens: 5, totalTokens: 10, totalCost: 1, metadata: { agents: ["claude", "codex"] } }],
          session: [
            { agent: "claude", period: "a", inputTokens: 1, totalTokens: 1, totalCost: 0.4, metadata: { lastActivity: "2026-10-31T01:00:00.000Z" } },
            { agent: "codex", period: "b", inputTokens: 2, totalTokens: 2, totalCost: 0.5, metadata: { lastActivity: "2026-10-31T02:00:00.000Z" } },
            { agent: "claude", period: "c", inputTokens: 3, totalTokens: 3, totalCost: 0.1, metadata: {} },
          ],
          totals: { totalCost: 1 },
        }),
      );
      const view = toView("all", daily, sessions, undefined, "2026-10-31", "2026-10-25", "2026-10-02");
      assert.strictEqual(view.today.cost, 1);
      assert.deepStrictEqual(
        view.sessions.map((s) => [s.agent, s.id]),
        [
          ["codex", "b"],
          ["claude", "a"],
          ["claude", "c"],
        ],
      );
      assert.deepStrictEqual(
        view.agents?.map((a) => [a.agent, a.sessions, a.tokens.total]),
        [
          ["claude", 2, 4],
          ["codex", 1, 2],
        ],
      );
    }),
  );

  it.effect("rejects output that isn't a report", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(decodeDaily("Error: no data"));
      assert.strictEqual(result._tag, "Failure");
    }),
  );

  it("tells a locked agent database, worth retrying, from other failures", () => {
    assert.isTrue(
      isLockedError(
        `Error: CliError("Failed to inspect Antigravity database '/x/conversations/a.db': database is locked (code 5)")`,
      ),
    );
    assert.isFalse(isLockedError("Error: unknown command"));
  });
});
