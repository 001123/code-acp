import { assert, describe, it } from "@effect/vitest";
import { ChangeSet } from "../src/fileChanges";

const checkpoint = (turn: number, message: number | undefined) => ({ turn, tree: `t${turn}`, label: "", at: 0, message });

describe("checkpoints across a reload", () => {
  it("moves checkpoints onto the turns of their replayed messages", () => {
    const changes = ChangeSet.fromSaved({ root: "/w", checkpoints: [checkpoint(1, 0), checkpoint(3, 2)], messages: 3 });
    changes.matchReplay([10, 11, 12]);
    assert.deepStrictEqual(
      changes.checkpoints.map((c) => [c.turn, c.message]),
      [
        [10, 0],
        [12, 2],
      ],
    );
    assert.strictEqual(changes.countMessage(), 3);
    assert.strictEqual(changes.messages, 4);
  });

  it("drops the positions when the history doesn't line up", () => {
    const changes = ChangeSet.fromSaved({ root: "/w", checkpoints: [checkpoint(1, 0)], messages: 2 });
    changes.matchReplay([10, 11, 12]);
    assert.deepStrictEqual(
      changes.checkpoints.map((c) => [c.turn, c.message]),
      [[1, undefined]],
    );
    // Counting starts over from the replayed history.
    assert.strictEqual(changes.countMessage(), 3);
  });

  it("doesn't count messages saved before they were counted", () => {
    const changes = ChangeSet.fromSaved({ root: "/w", checkpoints: [checkpoint(1, undefined)] });
    assert.isUndefined(changes.countMessage());
    changes.matchReplay([10]);
    assert.deepStrictEqual(changes.checkpoints[0]!.turn, 1);
    assert.strictEqual(changes.countMessage(), 1);
  });
});
