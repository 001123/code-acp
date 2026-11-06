import { assert, describe, it } from "@effect/vitest";
import { edgeEnds } from "../src/ui/diagramHover";

describe("edgeEnds", () => {
  it("splits an edge id at known node ids, even ones with underscores", () => {
    const ids = new Set(["a_b", "c", "S"]);
    assert.deepStrictEqual(edgeEnds("L_a_b_c_0", ids), ["a_b", "c"]);
    assert.deepStrictEqual(edgeEnds("L_a_b_S_12", ids), ["a_b", "S"]);
  });

  it("gives up on ids it can't place", () => {
    assert.strictEqual(edgeEnds("L_x_y_0", new Set(["a"])), undefined);
    assert.strictEqual(edgeEnds("other", new Set(["a"])), undefined);
  });
});
