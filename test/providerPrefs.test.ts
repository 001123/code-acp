import { assert, describe, it } from "@effect/vitest";
import { isHidden, orderModels } from "../src/ui/modelPrefs";
import { formatArgs, parseArgs } from "../src/ui/settings/args";

const models = ["a", "b", "c", "d"].map((value) => ({ value }));

describe("orderModels", () => {
  it("keeps the agent's order without a preference", () => {
    assert.deepStrictEqual(orderModels(models, {}), models);
  });

  it("puts the ordered models first, the others after them in the agent's order", () => {
    assert.deepStrictEqual(
      orderModels(models, { modelOrder: ["c", "gone", "a"] }).map((m) => m.value),
      ["c", "a", "b", "d"],
    );
  });

  it("knows the hidden ones", () => {
    assert.isTrue(isHidden({ hiddenModels: ["b"] }, "b"));
    assert.isFalse(isHidden({}, "b"));
  });
});

describe("parseArgs", () => {
  it("splits at spaces and keeps quoted text together", () => {
    assert.deepStrictEqual(parseArgs(`--a 1  --b "two words" 'it"s' ""`), ["--a", "1", "--b", "two words", 'it"s', ""]);
    assert.deepStrictEqual(parseArgs("   "), []);
  });

  it("reads back what formatArgs writes", () => {
    const args = ["--a", "two words", 'say "hi"', ""];
    assert.deepStrictEqual(parseArgs(formatArgs(args)), args);
  });
});
