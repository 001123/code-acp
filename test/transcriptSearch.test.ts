// @vitest-environment happy-dom
import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import en from "../src/l10n/en";
import { findMatches, foldWithOffsets } from "../src/ui/chat/search";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class FakeHighlight extends Set<Range> {
  priority = 0;
  constructor(...ranges: Range[]) {
    super(ranges);
  }
}
const highlights = new Map<string, FakeHighlight>();
Object.defineProperty(globalThis, "Highlight", { value: FakeHighlight, configurable: true });
Object.defineProperty(globalThis, "CSS", { value: { highlights }, configurable: true });
const { findRanges, nearestMatch, openAround, TranscriptSearch } = await import("../src/ui/chat/transcriptSearch");

window.dispatchEvent(new MessageEvent("message", { data: { type: "l10n", lang: "en", strings: en } }));

const dom = (html: string) => {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.append(root);
  return root;
};
const texts = (ranges: Range[]) => ranges.map((range) => range.toString());
const settle = (ms: number) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

describe("findMatches", () => {
  const slices = (text: string, query: string) =>
    findMatches(text, query).map(({ start, end }) => text.slice(start, end));

  it("ignores case and diacritics", () => {
    assert.deepStrictEqual(slices("Tìm KIẾM và tim kiem", "tim kiem"), ["Tìm KIẾM", "tim kiem"]);
    assert.deepStrictEqual(slices("Đường đi", "duong"), ["Đường"]);
    assert.deepStrictEqual(slices("tim kiem", "Tìm"), ["tim"]);
  });

  it("maps offsets back through decomposed text, marks going with their letter", () => {
    const decomposed = "tìm kiếm".normalize("NFD");
    assert.deepStrictEqual(slices(`x ${decomposed} y`, "tim kiem"), [decomposed]);
    assert.deepStrictEqual(foldWithOffsets("éa").offsets, [0, 2, 3]);
  });

  it("handles characters outside the BMP and letters that fold to several", () => {
    assert.deepStrictEqual(slices("😀abc😀", "b"), ["b"]);
    assert.deepStrictEqual(slices("한글", "글"), ["글"]);
  });

  it("reads a line break as a space, finds nothing for nothing, and stops at the limit", () => {
    assert.deepStrictEqual(slices("foo\nbar", "foo bar"), ["foo\nbar"]);
    assert.deepStrictEqual(findMatches("abc", ""), []);
    assert.lengthOf(findMatches("aaaa", "a", 2), 2);
    assert.lengthOf(findMatches("aaaa", "aa"), 2);
  });
});

describe("findRanges", () => {
  afterEach(() => void (document.body.innerHTML = ""));

  it("finds text split by inline elements, but not across blocks", () => {
    const root = dom(`<p>hello <b>wor</b><i>ld</i></p><p>hello</p><p>world</p>`);
    assert.deepStrictEqual(texts(findRanges(root, "hello world")), ["hello world"]);
    assert.lengthOf(findRanges(root, "helloworld"), 0);
    assert.deepStrictEqual(texts(findRanges(root, "world")), ["world", "world"]);
  });

  it("leaves out buttons, hidden parts and placeholders, not collapsed sections", () => {
    const root = dom(
      `<button>needle</button><div hidden>needle</div><div class="empty">needle</div><div class="waiting">needle</div><details><summary>x</summary><pre>a needle</pre></details>`,
    );
    const [only, ...rest] = findRanges(root, "needle");
    assert.isEmpty(rest);
    assert.strictEqual(only!.startContainer.parentElement!.tagName, "PRE");
  });

  it("stops at the limit, over several blocks", () => {
    assert.lengthOf(findRanges(dom(`<p>a a</p><p>a a</p>`), "a", 3), 3);
  });

  it("can keep to the questions and answers", () => {
    const root = dom(
      `<div class="msg user"><p>needle</p></div><div class="msg assistant md"><p>needle</p></div><div class="plan">needle</div><details class="thought"><p>needle</p></details><details class="tool"><summary>needle</summary><div class="tool-body">needle<div class="msg assistant">needle</div></div></details><details class="activity"><div class="msg assistant">needle</div></details>`,
    );
    assert.lengthOf(findRanges(root, "needle"), 8);
    const ranges = findRanges(root, "needle", undefined, true);
    assert.deepStrictEqual(
      ranges.map((range) => range.startContainer.parentElement!.parentElement!.className),
      ["msg user", "msg assistant md"],
    );
  });

  it("finds nothing for an empty query", () => {
    assert.isEmpty(findRanges(dom(`<p>a</p>`), ""));
  });
});

describe("nearestMatch", () => {
  afterEach(() => void (document.body.innerHTML = ""));

  const entries = (bottoms: number[]) => {
    const root = dom(bottoms.map(() => `<div>x</div>`).join(""));
    root.getBoundingClientRect = () => ({ top: 100 }) as DOMRect;
    [...root.children].forEach((child, i) => (child.getBoundingClientRect = () => ({ bottom: bottoms[i] }) as DOMRect));
    return root;
  };

  it("takes the first match not above the view", () => {
    const root = entries([50, 150, 250]);
    assert.strictEqual(nearestMatch(findRanges(root, "x"), root), 1);
  });

  it("takes the last match when all are above it", () => {
    const root = entries([50, 60]);
    assert.strictEqual(nearestMatch(findRanges(root, "x"), root), 1);
  });
});

describe("openAround", () => {
  afterEach(() => void (document.body.innerHTML = ""));

  it("opens the sections around a match and closes them when moving on", () => {
    const root = dom(
      `<details id="a"><summary>s</summary><details id="b"><summary>s</summary><p>one</p></details></details><details id="c"><summary>s</summary><p>two</p></details>`,
    );
    const [a, b, c] = ["a", "b", "c"].map((id) => root.querySelector<HTMLDetailsElement>(`#${id}`)!);
    let opened = openAround(findRanges(root, "one")[0]!, []);
    assert.isTrue(a!.open && b!.open);
    opened = openAround(findRanges(root, "two")[0]!, opened);
    assert.isFalse(a!.open || b!.open);
    assert.isTrue(c!.open);
    assert.deepStrictEqual(opened, [c]);
  });

  it("does not open a section for a match in its summary, nor take over one the user opened", () => {
    const root = dom(
      `<details id="a"><summary>title</summary><p>x</p></details><details id="b" open><summary>s</summary><p>body</p></details>`,
    );
    const a = root.querySelector<HTMLDetailsElement>("#a")!;
    const b = root.querySelector<HTMLDetailsElement>("#b")!;
    assert.deepStrictEqual(openAround(findRanges(root, "title")[0]!, []), []);
    assert.isFalse(a.open);
    assert.deepStrictEqual(openAround(findRanges(root, "body")[0]!, []), []);
    assert.isTrue(b.open);
  });
});

describe("TranscriptSearch", () => {
  let host: HTMLElement;
  let messages: HTMLElement;
  let root: Root;
  let revealed = 0;
  let closed = 0;

  const Search = ({ resetKey, request }: { resetKey: unknown; request: number }) => {
    const [messagesOnly, onMessagesOnlyChange] = useState(false);
    return createElement(TranscriptSearch, {
      root: { current: messages },
      resetKey,
      request,
      messagesOnly,
      onMessagesOnlyChange,
      onReveal: () => revealed++,
      onClose: () => closed++,
    });
  };
  const render = (resetKey: unknown = 1, request = 1) =>
    act(() => root.render(createElement(Search, { resetKey, request })));
  const input = () => host.querySelector("input")!;
  const type = async (value: string) => {
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(input(), value);
      input().dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle(130);
  };
  const press = (key: string, shiftKey = false) =>
    act(async () => void input().dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true })));
  const count = () => host.querySelector(".transcript-search-count")?.textContent;
  const currentText = () => [...(highlights.get("transcript-search-current") ?? [])][0]?.toString();

  beforeEach(async () => {
    revealed = 0;
    closed = 0;
    highlights.clear();
    host = document.body.appendChild(document.createElement("div"));
    messages = document.body.appendChild(document.createElement("div"));
    messages.innerHTML = `<p>first needle</p><details id="d"><summary>s</summary><pre>second NEEDLE</pre></details><p>third nèedle</p>`;
    // The view starts above everything, so the first match is the nearest.
    messages.getBoundingClientRect = () => ({ top: -1, left: 0, width: 0, height: 0 }) as DOMRect;
    root = createRoot(host);
    await render();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.innerHTML = "";
  });

  it("focuses its input, and marks and counts the matches", async () => {
    assert.strictEqual(document.activeElement, input());
    await type("needle");
    assert.strictEqual(highlights.get("transcript-search")!.size, 3);
    assert.strictEqual(count(), "1 of 3");
    assert.strictEqual(currentText(), "needle");
    assert.isAbove(revealed, 0);
  });

  it("walks through the matches with wrap-around, opening what hides one", async () => {
    const details = messages.querySelector("details")!;
    await type("needle");
    await press("Enter");
    assert.strictEqual(currentText(), "NEEDLE");
    assert.isTrue(details.open);
    await press("Enter");
    assert.strictEqual(currentText(), "nèedle");
    assert.isFalse(details.open);
    await press("Enter");
    assert.strictEqual(count(), "1 of 3");
    await press("Enter", true);
    assert.strictEqual(count(), "3 of 3");
  });

  it("narrows the search to the messages with the toggle, keeping the input focused", async () => {
    messages.innerHTML = `<div class="msg user"><p>needle</p></div><details class="tool"><summary>s</summary><pre>needle</pre></details>`;
    await type("needle");
    assert.strictEqual(count(), "1 of 2");
    const toggle = host.querySelector<HTMLButtonElement>("[aria-pressed]")!;
    assert.strictEqual(toggle.getAttribute("aria-pressed"), "false");
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    toggle.dispatchEvent(down);
    assert.isTrue(down.defaultPrevented);
    await act(async () => toggle.click());
    await settle(130);
    assert.strictEqual(toggle.getAttribute("aria-pressed"), "true");
    assert.strictEqual(count(), "1 of 1");
    await act(async () => toggle.click());
    await settle(130);
    assert.strictEqual(count(), "1 of 2");
  });

  it("says when nothing matches", async () => {
    await type("nothing");
    assert.strictEqual(count(), "No results");
    assert.isEmpty(highlights.get("transcript-search")!);
    assert.isFalse(highlights.has("transcript-search-current"));
    assert.isTrue(host.querySelector<HTMLButtonElement>(`[title^="Previous"]`)!.disabled);
  });

  it("follows text that arrives, keeping the current match and not scrolling", async () => {
    await type("needle");
    await press("Enter");
    const before = revealed;
    messages.insertAdjacentHTML("beforeend", "<p>new needle</p>");
    await settle(300);
    assert.strictEqual(count(), "2 of 4");
    assert.strictEqual(revealed, before);
  });

  it("starts over on another tab", async () => {
    await type("needle");
    await press("Enter");
    messages.innerHTML = "<p>only needle</p>";
    await render(2);
    await settle(130);
    assert.strictEqual(count(), "1 of 1");
  });

  it("closes on Escape, and leaves no trace when gone", async () => {
    const details = messages.querySelector("details")!;
    await type("needle");
    await press("Enter");
    await press("Escape");
    assert.strictEqual(closed, 1);
    await act(async () => root.unmount());
    assert.isFalse(details.open);
    assert.strictEqual(highlights.size, 0);
    root = createRoot(host);
  });

  it("focuses its input again when asked again", async () => {
    input().blur();
    await render(1, 2);
    assert.strictEqual(document.activeElement, input());
  });
});
