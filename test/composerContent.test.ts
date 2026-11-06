import { assert, describe, it } from "@effect/vitest";
import type { Attachment } from "../src/chat/protocol";
import { addToken, appendContent, contentOf, pruneTokens, tokenInfos } from "../src/ui/chat/composerContent";

const file = (name: string): Attachment => ({ kind: "uri", uri: `file:///${name}`, name });
const image = (name: string): Attachment => ({ kind: "data", name, mimeType: "image/png", data: "AAAA" });

describe("composer content", () => {
  it("rebuilds a message from its parts", () => {
    const a = file("a.ts");
    const b = file("b.ts");
    assert.deepStrictEqual(contentOf(["see ", { ...a, token: "@a.ts" }, " and", b]), {
      text: "see @a.ts and",
      inline: new Map([["@a.ts", a]]),
      attachments: [b],
    });
  });

  it("appends a message after what is there, renaming its tokens where they clash", () => {
    const first = file("a.ts");
    const second = file("other/a.ts");
    const content = appendContent(
      { text: "one @a.ts\n", inline: new Map([["@a.ts", first]]), attachments: [] },
      { text: "two @a.ts", inline: new Map([["@a.ts", second]]), attachments: [file("c.ts")] },
    );
    assert.strictEqual(content.text, "one @a.ts\n\ntwo @a.ts (2)");
    assert.deepStrictEqual([...content.inline.keys()], ["@a.ts", "@a.ts (2)"]);
    assert.strictEqual(content.inline.get("@a.ts (2)"), second);
    assert.strictEqual(content.attachments.length, 1);
  });

  it("appends to an empty composer without a gap", () => {
    assert.strictEqual(
      appendContent(
        { text: " \n", inline: new Map(), attachments: [] },
        { text: "two", inline: new Map(), attachments: [] },
      ).text,
      "two",
    );
  });

  it("marks image tokens", () => {
    assert.deepStrictEqual(
      tokenInfos(
        new Map([
          ["@a.ts", file("a.ts")],
          ["@b.png", image("b.png")],
        ]),
      ),
      [
        { token: "@a.ts", image: false },
        { token: "@b.png", image: true },
      ],
    );
  });
});

describe("tokens", () => {
  it("takes the attachment's name with the sigil", () => {
    const tokens = new Map<string, Attachment>();
    const a = file("a.ts");
    assert.strictEqual(addToken(tokens, new Set(), a, "$"), "$a.ts");
    assert.strictEqual(tokens.get("$a.ts"), a);
  });

  it("numbers tokens of the same name", () => {
    const tokens = new Map<string, Attachment>();
    assert.strictEqual(addToken(tokens, new Set(), image("a.png"), "@"), "@a.png");
    assert.strictEqual(addToken(tokens, new Set(["@a.png"]), image("a.png"), "@"), "@a.png (2)");
  });

  it("does not add a file already in the text", () => {
    const tokens = new Map<string, Attachment>([["@a.ts", file("a.ts")]]);
    assert.isUndefined(addToken(tokens, new Set(["@a.ts"]), file("a.ts"), "@"));
    assert.strictEqual(tokens.size, 1);
  });

  it("adds a file again once its token left the text", () => {
    const tokens = new Map<string, Attachment>([["@a.ts", file("a.ts")]]);
    assert.strictEqual(addToken(tokens, new Set(), file("a.ts"), "@"), "@a.ts");
  });

  it("forgets the tokens no longer shown", () => {
    const tokens = new Map<string, Attachment>([
      ["@a.ts", file("a.ts")],
      ["@b.ts", file("b.ts")],
    ]);
    pruneTokens(tokens, new Set(["@b.ts"]));
    assert.deepStrictEqual([...tokens.keys()], ["@b.ts"]);
  });
});
