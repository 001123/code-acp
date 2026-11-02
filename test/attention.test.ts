import { assert, describe, it } from "@effect/vitest";
import { Attention, type AttentionReason, shouldNotify } from "../src/chat/attention";

function setup() {
  const seen = new Set<string>();
  const badges: number[] = [];
  const notified: Array<[string, AttentionReason]> = [];
  const attention = new Attention<string>({
    sees: (tab) => seen.has(tab),
    badge: (count) => badges.push(count),
    notify: (tab, reason) => notified.push([tab, reason]),
  });
  return { attention, seen, badges, notified };
}

describe("Attention", () => {
  it("marks and announces a tab the user doesn't see", () => {
    const { attention, badges, notified } = setup();
    attention.raise("a", "finished");
    assert.strictEqual(attention.count, 1);
    assert.deepStrictEqual(badges, [1]);
    assert.deepStrictEqual(notified, [["a", "finished"]]);
  });

  it("ignores a tab the user sees", () => {
    const { attention, seen, notified } = setup();
    seen.add("a");
    attention.raise("a", "permission");
    assert.strictEqual(attention.count, 0);
    assert.deepStrictEqual(notified, []);
  });

  it("announces each reason once while marked", () => {
    const { attention, notified } = setup();
    attention.raise("a", "permission");
    attention.raise("a", "permission");
    attention.raise("a", "finished");
    assert.deepStrictEqual(notified, [
      ["a", "permission"],
      ["a", "finished"],
    ]);
    assert.strictEqual(attention.count, 1);
  });

  it("settles only the reason it was marked for", () => {
    const { attention } = setup();
    attention.raise("a", "finished");
    attention.settle("a", "permission");
    assert.strictEqual(attention.count, 1);
    attention.settle("a", "finished");
    assert.strictEqual(attention.count, 0);
  });

  it("clears the tabs the user sees on refresh", () => {
    const { attention, seen, badges } = setup();
    attention.raise("a", "finished");
    attention.raise("b", "permission");
    seen.add("b");
    attention.refresh();
    assert.strictEqual(attention.count, 1);
    assert.deepStrictEqual(badges, [1, 2, 1]);
  });

  it("lists the marked tabs by reason, the earliest first", () => {
    const { attention } = setup();
    attention.raise("b", "finished");
    attention.raise("a", "permission");
    attention.raise("c", "finished");
    assert.deepStrictEqual(attention.owners("finished"), ["b", "c"]);
    assert.deepStrictEqual(attention.owners("permission"), ["a"]);
  });
});

describe("shouldNotify", () => {
  it("notifies every reason by default", () => {
    const settings = { notifications: true, notifyFinished: true };
    assert.isTrue(shouldNotify("finished", settings));
    assert.isTrue(shouldNotify("permission", settings));
    assert.isTrue(shouldNotify("question", settings));
  });

  it("drops only finished tabs with notifyFinished off", () => {
    const settings = { notifications: true, notifyFinished: false };
    assert.isFalse(shouldNotify("finished", settings));
    assert.isTrue(shouldNotify("permission", settings));
    assert.isTrue(shouldNotify("question", settings));
  });

  it("drops every reason with notifications off", () => {
    const settings = { notifications: false, notifyFinished: true };
    assert.isFalse(shouldNotify("finished", settings));
    assert.isFalse(shouldNotify("permission", settings));
    assert.isFalse(shouldNotify("question", settings));
  });
});
