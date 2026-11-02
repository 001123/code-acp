import { assert, describe, it } from "@effect/vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
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
});

describe("file references", () => {
  it("decodes a file:// path", () => {
    assert.include(html("`file:///tmp/caf%C3%A9.txt`"), 'data-file="/tmp/café.txt"');
  });

  it("takes a path with a stray % as written", () => {
    assert.include(html("`file:///tmp/100%.txt`"), 'data-file="/tmp/100%.txt"');
    assert.include(html("[report](file:///tmp/100%.txt)"), 'data-file="/tmp/100%.txt"');
  });

  it("opens file:// links", () => {
    const link = html("[a](file:///w/a.ts#L12)");
    assert.include(link, 'href="file:///w/a.ts#L12"');
    assert.include(link, 'data-file="/w/a.ts"');
    assert.include(link, 'data-line="12"');
    assert.include(html("[a](file:///w/my%20dir/a.ts)"), 'data-file="/w/my dir/a.ts"');
  });

  it("keeps file:// out of images and drops links that name no file", () => {
    assert.notInclude(html("![a](file:///w/a.png)"), "file:");
    assert.notInclude(html("[a](file:///w/a*.ts)"), "file:");
    assert.notInclude(html("[a](javascript:alert(1))"), "javascript:");
  });
});
