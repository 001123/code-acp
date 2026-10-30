import { assert, describe, it } from "@effect/vitest";
import { getSchema } from "@tiptap/core";
import { composerExtensions, flatText, offsetAt, posAt, textOf, TOKEN_CHAR } from "../src/ui/chat/editor";
import { fenceLanguage, highlight } from "../src/ui/chat/highlight";
import { styleLines, type Span } from "../src/ui/chat/livePreview";

const kinds = (line: string) => styleLines([line])[0]!.spans.map((s: Span) => `${s.kind}:${line.slice(s.from, s.to)}`);

describe("composer live preview", () => {
  it("styles block syntax", () => {
    const styles = styleLines(["# Title", "> quote", "- item", "1. one", "---", "plain"]);
    assert.deepStrictEqual(
      styles.map((s) => s.block),
      ["h1", "quote", undefined, undefined, "hr", undefined],
    );
    assert.deepStrictEqual(kinds("## Sub **b**"), ["marker:**", "strong:b", "marker:**"]);
    assert.strictEqual(styleLines(["## Sub"])[0]!.prefix, 3);
    assert.strictEqual(styleLines(["#1 issue"])[0]!.block, undefined);
    assert.strictEqual(styleLines(["> quote"])[0]!.prefix, 2);
    assert.deepStrictEqual(styleLines([">", ">quote", "#", "#1"]).map((s) => s.block), [undefined, undefined, undefined, undefined]);
    assert.deepStrictEqual(kinds("- [ ] task"), ["bullet:- [ ]"]);
  });

  it("styles fenced code without inline syntax", () => {
    const styles = styleLines(["```ts", "# not a heading **x**", "```", "**bold**"]);
    assert.deepStrictEqual(
      styles.map((s) => [s.block, s.fence]),
      [["fence-open", 0], ["codeblock", 0], ["fence-close", 0], [undefined, undefined]],
    );
    assert.deepStrictEqual(styles[1]!.spans, []);
    assert.deepStrictEqual(kinds("**bold**"), ["marker:**", "strong:bold", "marker:**"]);
  });

  it("closes a fence only with a matching one", () => {
    const blocks = (lines: string[]) => styleLines(lines).map((s) => s.block);
    assert.deepStrictEqual(blocks(["````", "```", "````"]), ["fence-open", "codeblock", "fence-close"]);
    assert.deepStrictEqual(blocks(["```", "~~~", "``` x"]), ["fence-open", "codeblock", "codeblock"]);
  });

  it("styles inline syntax", () => {
    assert.deepStrictEqual(kinds("a *b* `c*d*` ~~e~~"), [
      "marker:*",
      "em:b",
      "marker:*",
      "marker:`",
      "code:c*d*",
      "marker:`",
      "marker:~~",
      "strike:e",
      "marker:~~",
    ]);
    assert.deepStrictEqual(kinds("[docs](https://x.y)"), ["marker:[", "link:docs", "marker:](https://x.y)"]);
    assert.deepStrictEqual(kinds("snake_case_name and 2 * 3 * 4"), []);
  });
});

describe("composer code highlighting", () => {
  it("reads the fence language", () => {
    assert.deepStrictEqual(fenceLanguage("ts title=\"a.ts\""), { grammar: "tsx", name: "TypeScript" });
    assert.deepStrictEqual(fenceLanguage(" JS"), { grammar: "javascript", name: "JavaScript" });
    assert.strictEqual(fenceLanguage(""), undefined);
    assert.strictEqual(fenceLanguage("brainfuck"), undefined);
  });

  it("colors each line", () => {
    const lines = highlight("javascript", 'const a = "x";\n// hi');
    assert.strictEqual(lines.length, 2);
    const colored = (n: number, text: string) => lines[n]!.find((t) => 'const a = "x";\n// hi'.split("\n")[n]!.slice(t.from, t.to) === text)?.style;
    assert.include(colored(0, "const"), "--hl-token-keyword");
    assert.include(colored(0, '"x"') ?? colored(0, "x"), "--hl-token-string");
    assert.include(colored(1, "// hi"), "--hl-token-comment");
  });
});

describe("composer editor text", () => {
  const schema = getSchema(composerExtensions(() => ""));
  const doc = schema.nodes.doc!.create(null, [
    schema.nodes.paragraph!.create(null, [schema.text("see "), schema.nodes.token!.create({ token: "@a.ts" }), schema.text(" ok")]),
    schema.nodes.paragraph!.create(),
    schema.nodes.paragraph!.create(null, [schema.text("end")]),
  ]);

  it("reads lines and tokens", () => {
    assert.strictEqual(textOf(doc), "see @a.ts ok\n\nend");
    assert.strictEqual(flatText(doc), `see ${TOKEN_CHAR} ok\n\nend`);
  });

  it("maps offsets to positions and back", () => {
    const flat = flatText(doc);
    for (let offset = 0; offset <= flat.length; offset++) assert.strictEqual(offsetAt(doc, posAt(doc, offset)), offset);
    assert.strictEqual(doc.resolve(posAt(doc, flat.indexOf("end"))).parent.textContent, "end");
  });
});
