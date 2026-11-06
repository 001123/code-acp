import { assert, describe, it } from "@effect/vitest";
import { TabList } from "../src/chat/tabs";
import { TurnTraces, type TurnTrace } from "../src/chat/turnTraces";

const trace = (stopReason: string): TurnTrace => ({
  stopReason,
  durationMs: 1,
  waiting: { asks: 0, ms: 0 },
  tools: { total: 1, failed: 0, kinds: { read: 1 } },
  subagents: 0,
  sessionId: "s",
});

const entry = (turn: number, message: number) => ({ turn, message, trace: trace(`t${turn}`) });

describe("TurnTraces", () => {
  it("moves traces onto the turns of their replayed messages", () => {
    const traces = TurnTraces.fromSaved({ messages: 3, traces: [entry(1, 0), entry(3, 2)] });
    assert.deepStrictEqual(traces.matchReplay([10, 11, 12]), [
      { turn: 10, trace: trace("t1") },
      { turn: 12, trace: trace("t3") },
    ]);
    assert.strictEqual(traces.countMessage(), 3);
    // Taking back the last message goes by the new turns.
    traces.forgetFrom(12);
    assert.deepStrictEqual(
      traces.saved?.traces.map((each) => each.turn),
      [10],
    );
  });

  it("drops the traces when the replayed history has another number of messages", () => {
    const traces = TurnTraces.fromSaved({ messages: 3, traces: [entry(1, 0)] });
    assert.deepStrictEqual(traces.matchReplay([10, 11]), []);
    assert.deepStrictEqual(traces.saved, { messages: 2, traces: [] });
  });

  it("starts over for another session", () => {
    const traces = TurnTraces.fromSaved({ messages: 1, traces: [entry(1, 0)] });
    traces.clear();
    assert.isUndefined(traces.saved);
    assert.strictEqual(traces.countMessage(), 0);
  });

  it("keeps the latest traces", () => {
    const traces = new TurnTraces();
    for (let turn = 0; turn < 105; turn++) {
      traces.add(turn, traces.countMessage(), trace("t"));
    }
    assert.strictEqual(traces.saved?.traces.length, 100);
    assert.strictEqual(traces.saved?.traces[0]?.turn, 5);
  });

  it("comes back with its tab, and unreadable traces don't cost the tab", () => {
    const list = new TabList(undefined, () => "/w");
    const tab = list.active;
    tab.sessionId = "s";
    tab.used = true;
    tab.traces.add(1, tab.traces.countMessage(), trace("kept"));
    const restored = new TabList(list.saved, () => "/w").active;
    assert.deepStrictEqual(restored.traces.saved, {
      messages: 1,
      traces: [{ turn: 1, message: 0, trace: trace("kept") }],
    });

    const unreadable = new TabList({ active: 0, tabs: [{ sessionId: "s", traces: { messages: "many" } }] }, () => "/w")
      .active;
    assert.strictEqual(unreadable.reopen?.sessionId, "s");
    assert.isUndefined(unreadable.traces.saved);
  });
});
