import { assert, describe, it } from "@effect/vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { inCodeFence } from "../src/ui/chat/attachments";
import { MarkdownView } from "../src/ui/markdown";

const html = (text: string, tokens: string[] = []) =>
  renderToStaticMarkup(
    createElement(MarkdownView, { text, breaks: true, tokens, renderToken: (i) => createElement("b", null, `#${i}`) }),
  );

describe("user Markdown", () => {
  it("keeps typed newlines and formats Markdown", () => {
    assert.strictEqual(html("**hi**\nthere"), "<div><p><strong>hi</strong><br/>\nthere</p></div>");
  });

  it("draws tokens outside code, once each", () => {
    assert.strictEqual(html("see @a.png and @a.png", ["@a.png"]), "<div><p>see <b>#0</b> and @a.png</p></div>");
    assert.strictEqual(html("`@a.png` then _@b.ts_", ["@a.png", "@b.ts"]), "<div><p><code>@a.png</code> then <em><b>#1</b></em></p></div>");
  });

  it("never renders raw HTML", () => {
    assert.notInclude(html("<mark data-token-index=\"0\">x</mark>", ["y"]), "<b>");
  });

  it("tells when the caret is inside a code fence", () => {
    assert.isFalse(inCodeFence("hello", 5));
    assert.isTrue(inCodeFence("```ts", 5));
    assert.isTrue(inCodeFence("```ts\nconst a = 1", 16));
    assert.isFalse(inCodeFence("```ts\nx\n```", 11));
    assert.isTrue(inCodeFence("````\n```\n", 9));
  });
});
