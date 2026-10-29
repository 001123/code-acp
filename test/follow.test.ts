import { assert, describe, it } from "@effect/vitest";
import { followTarget, lineSpan, mergeCall } from "../src/chat/follow";

describe("follow the agent", () => {
  it("finds the lines of a text", () => {
    const text = "a\nb\nc\nd\n";
    assert.deepStrictEqual(lineSpan(text, "b\nc"), { startLine: 1, endLine: 2 });
    assert.deepStrictEqual(lineSpan(text, "c\n"), { startLine: 2, endLine: 2 });
    assert.deepStrictEqual(lineSpan(text, "a"), { startLine: 0, endLine: 0 });
    assert.strictEqual(lineSpan(text, "x"), undefined);
    assert.strictEqual(lineSpan(text, ""), undefined);
  });

  it("keeps what earlier updates of a tool call said", () => {
    const started = mergeCall(undefined, {
      status: "pending",
      locations: [{ path: "/w/a.ts" }],
      content: [{ type: "diff", path: "/w/a.ts", oldText: "old", newText: "new" }],
    });
    const done = mergeCall(started, { status: "completed" });
    assert.deepStrictEqual(done.locations, [{ path: "/w/a.ts" }]);
    assert.deepStrictEqual(done.diffs, [{ path: "/w/a.ts", oldText: "old", newText: "new" }]);
    assert.strictEqual(done.status, "completed");
  });

  it("shows an edit where it lands, before and after it is written", () => {
    const call = mergeCall(undefined, {
      locations: [{ path: "/w/a.ts" }],
      content: [{ type: "diff", path: "/w/a.ts", oldText: "two\n", newText: "TWO\nTWO-B\n" }],
    });
    assert.deepStrictEqual(followTarget(call, "/w/a.ts", "one\ntwo\nthree\n"), {
      path: "/w/a.ts",
      startLine: 1,
      endLine: 1,
      highlight: true,
    });
    assert.deepStrictEqual(followTarget(call, "/w/a.ts", "one\nTWO\nTWO-B\nthree\n"), {
      path: "/w/a.ts",
      startLine: 1,
      endLine: 2,
      highlight: true,
    });
  });

  it("falls back to the location's line", () => {
    const read = mergeCall(undefined, { locations: [{ path: "/w/a.ts", line: 40 }] });
    assert.deepStrictEqual(followTarget(read, "/w/a.ts", undefined), { path: "/w/a.ts", startLine: 39, endLine: 39, highlight: false });
    const edit = mergeCall(undefined, {
      locations: [{ path: "/w/a.ts" }],
      content: [{ type: "diff", path: "/w/a.ts", oldText: "gone", newText: "" }],
    });
    assert.deepStrictEqual(followTarget(edit, "/w/a.ts", "nothing here"), { path: "/w/a.ts", startLine: 0, endLine: 0, highlight: false });
  });
});
