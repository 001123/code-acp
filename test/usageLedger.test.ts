import { assert, describe, it } from "@effect/vitest";
import { addCost, addTurn, EMPTY_LEDGER, mergeLedgers, splitByMonth, summarize, type Ledger } from "../src/usageLedger";

const ref = { agentId: "claude", sessionId: "s1", cwd: "/work/app", title: "Fix tests" };
const usage = { totalTokens: 150, inputTokens: 100, outputTokens: 50, cachedReadTokens: 20, thoughtTokens: null };

describe("addTurn", () => {
  it("adds the turn's tokens to its session and day", () => {
    let ledger = addTurn(EMPTY_LEDGER, ref, usage, "2026-10-30", 1);
    ledger = addTurn(ledger, ref, usage, "2026-10-31", 2);
    const session = ledger.sessions["claude s1"]!;
    assert.strictEqual(session.turns, 2);
    assert.strictEqual(session.tokens.total, 300);
    assert.strictEqual(session.tokens.cachedRead, 40);
    assert.strictEqual(session.firstAt, 1);
    assert.strictEqual(session.lastAt, 2);
    assert.strictEqual(ledger.days["2026-10-31"]!.tokens.input, 100);
  });

  it("counts a turn without usage", () => {
    const ledger = addTurn(EMPTY_LEDGER, ref, { bogus: true }, "2026-10-31", 1);
    assert.strictEqual(ledger.days["2026-10-31"]!.turns, 1);
    assert.strictEqual(ledger.days["2026-10-31"]!.tokens.total, 0);
  });
});

describe("addCost", () => {
  const cost = (amount: number) => ({ amount, currency: "USD" });

  it("adds what the cumulative cost grew by", () => {
    let ledger = addCost(EMPTY_LEDGER, ref, cost(0.5), "2026-10-30", 1);
    ledger = addCost(ledger, ref, cost(0.8), "2026-10-31", 2);
    assert.closeTo(ledger.sessions["claude s1"]!.cost.USD!, 0.8, 1e-9);
    assert.closeTo(ledger.days["2026-10-30"]!.cost.USD!, 0.5, 1e-9);
    assert.closeTo(ledger.days["2026-10-31"]!.cost.USD!, 0.3, 1e-9);
  });

  it("takes a drop as an agent counting from zero again", () => {
    let ledger = addCost(EMPTY_LEDGER, ref, cost(0.5), "2026-10-31", 1);
    ledger = addCost(ledger, ref, cost(0.2), "2026-10-31", 2);
    assert.closeTo(ledger.sessions["claude s1"]!.cost.USD!, 0.7, 1e-9);
  });

  it("doesn't count a reopened session's earlier cost again", () => {
    const ledger = addCost(EMPTY_LEDGER, ref, cost(1.25), "2026-10-31", 1, cost(1));
    assert.closeTo(ledger.days["2026-10-31"]!.cost.USD!, 0.25, 1e-9);
  });
});

describe("summarize", () => {
  const ledger: Ledger = [
    ["2025-07-01", 1],
    ["2026-10-25", 2],
    ["2026-10-31", 3],
  ].reduce<Ledger>(
    (acc, [day, now]) =>
      addTurn(
        addCost(acc, { ...ref, sessionId: String(now), title: undefined }, { amount: 1, currency: "USD" }, day as string, now as number),
        ref,
        usage,
        day as string,
        now as number,
      ),
    EMPTY_LEDGER,
  );
  const everything = { text: "", limit: 100 };

  it("sums today, the week, the month and all time, keeping every day", () => {
    const summary = summarize(ledger, "2026-10-31", "2026-10-25", "2026-10-02", everything);
    assert.strictEqual(summary.today.turns, 1);
    assert.strictEqual(summary.week.turns, 2);
    assert.strictEqual(summary.week.cost.USD, 2);
    assert.strictEqual(summary.month.tokens.total, 300);
    assert.strictEqual(summary.all.turns, 3);
    assert.strictEqual(summary.all.cost.USD, 3);
    assert.deepStrictEqual(
      summary.days.map((d) => d.day),
      ["2026-10-31", "2026-10-25", "2025-07-01"],
    );
  });

  it("sums by agent", () => {
    const summary = summarize(ledger, "2026-10-31", "2026-10-25", "2026-10-02", everything);
    assert.strictEqual(summary.agents.length, 1);
    assert.strictEqual(summary.agents[0]!.sessions, 4);
    assert.strictEqual(summary.agents[0]!.turns, 3);
    assert.strictEqual(summary.agents[0]!.cost.USD, 3);
  });

  it("pages and searches the sessions, most recent first", () => {
    const page = summarize(ledger, "2026-10-31", "2026-10-25", "2026-10-02", { text: "", limit: 2 });
    assert.deepStrictEqual(
      page.sessions.map((s) => s.sessionId),
      ["s1", "3"],
    );
    assert.strictEqual(page.sessionCount, 4);
    assert.notProperty(page.sessions[0]!, "lastCost");
    const found = summarize(ledger, "2026-10-31", "2026-10-25", "2026-10-02", { text: "FIX", limit: 10 });
    assert.deepStrictEqual(
      found.sessions.map((s) => s.sessionId),
      ["s1"],
    );
    const byName = summarize(ledger, "2026-10-31", "2026-10-25", "2026-10-02", { text: "sonnet", limit: 10 }, () => "Claude Sonnet");
    assert.strictEqual(byName.sessionCount, 4);
  });
});

describe("month files", () => {
  const cost = (amount: number) => ({ amount, currency: "USD" });

  it("sums a session kept on across months, keeping the later month's title and cost", () => {
    const october = addCost(addTurn(EMPTY_LEDGER, ref, usage, "2026-10-31", 1), ref, cost(0.5), "2026-10-31", 2);
    const renamed = { ...ref, title: "Fix more tests" };
    const november = addTurn(EMPTY_LEDGER, renamed, usage, "2026-11-01", 3);
    const merged = mergeLedgers([october, addCost(november, renamed, cost(0.75), "2026-11-01", 4, cost(0.5))]);
    const session = merged.sessions["claude s1"]!;
    assert.strictEqual(session.turns, 2);
    assert.strictEqual(session.tokens.total, 300);
    assert.closeTo(session.cost.USD!, 0.75, 1e-9);
    assert.strictEqual(session.title, "Fix more tests");
    assert.strictEqual(session.firstAt, 1);
    assert.strictEqual(session.lastAt, 4);
    assert.deepStrictEqual(session.lastCost, cost(0.75));
    assert.deepStrictEqual(Object.keys(merged.days).sort(), ["2026-10-31", "2026-11-01"]);
  });

  it("splits a whole ledger by month without losing anything", () => {
    let ledger = addTurn(EMPTY_LEDGER, ref, usage, "2026-09-30", Date.UTC(2026, 8, 30));
    ledger = addTurn(ledger, { ...ref, sessionId: "s2" }, usage, "2026-10-01", Date.UTC(2026, 9, 1));
    const months = splitByMonth(ledger, (ms) => new Date(ms).toISOString().slice(0, 7));
    assert.deepStrictEqual([...months.keys()].sort(), ["2026-09", "2026-10"]);
    assert.deepStrictEqual(Object.keys(months.get("2026-09")!.sessions), ["claude s1"]);
    assert.deepStrictEqual(mergeLedgers([...months.values()]), ledger);
  });
});
