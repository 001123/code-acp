import { assert, describe, it } from "@effect/vitest";
import { imageAttachment, pastedContent } from "../src/ui/chat/clipboard";

const png = "data:image/png;base64,AAAA";
const jpg = "data:image/jpeg;base64,BBBB";

describe("pasting a copied message", () => {
  it("reads base64 images only", () => {
    assert.deepStrictEqual(imageAttachment("a.png", png), { kind: "data", name: "a.png", mimeType: "image/png", data: "AAAA" });
    assert.isUndefined(imageAttachment("a.svg", "data:image/svg+xml,<svg/>"));
    assert.isUndefined(imageAttachment("a.txt", "data:text/plain;base64,AAAA"));
  });

  it("keeps tokens that are free", () => {
    const pasted = pastedContent("see @image.png and @image.jpg (2)", [
      { token: "@image.png", src: png },
      { token: "@image.jpg (2)", src: jpg },
    ], () => false);
    assert.strictEqual(pasted.text, "see @image.png and @image.jpg");
    assert.deepStrictEqual(pasted.inline.map((x) => x.token), ["@image.png", "@image.jpg"]);
    assert.strictEqual(pasted.inline[1]!.attachment.kind === "data" && pasted.inline[1]!.attachment.mimeType, "image/jpeg");
  });

  it("renames tokens the composer already has", () => {
    const taken = new Set(["@image.png", "@image.png (2)"]);
    const pasted = pastedContent("@image.png (2) then @image.png", [
      { token: "@image.png", src: png },
      { token: "@image.png (2)", src: png },
    ], (token) => taken.has(token));
    assert.strictEqual(pasted.text, "@image.png (4) then @image.png (3)");
  });

  it("leaves out images whose token is gone or unreadable", () => {
    const pasted = pastedContent("just @a.png", [
      { token: "@b.png", src: png },
      { token: "@a.png", src: "https://example.com/a.png" },
    ], () => false);
    assert.strictEqual(pasted.text, "just @a.png");
    assert.lengthOf(pasted.inline, 0);
  });
});
