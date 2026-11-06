import { assert, describe, it } from "@effect/vitest";
import {
  codeKey,
  continueList,
  paragraphEdit,
  quoteEdit,
  type Edit,
  type Selected,
} from "../src/ui/chat/composerEdits";

/** `text` with "|" at the caret. */
const at = (text: string): Selected => {
  const caret = text.indexOf("|");
  return { text: text.replace("|", ""), from: caret, to: caret };
};

/** The edits applied as the editor does: a replacement leaves the caret after it. */
const applied = ({ text, from }: Selected, edits: ReadonlyArray<Edit>): string => {
  let caret = from;
  for (const edit of edits) {
    if ("caret" in edit) {
      caret = edit.caret;
    } else {
      text = text.slice(0, edit.from) + edit.text + text.slice(edit.to);
      caret = edit.from + edit.text.length;
    }
  }
  return `${text.slice(0, caret)}|${text.slice(caret)}`;
};

const listKey = (text: string) => {
  const selected = at(text);
  const edit = continueList(selected);
  return edit && applied(selected, [edit]);
};

const onCode = (text: string, key: "Enter" | "ArrowDown", shift = false) => {
  const selected = at(text);
  const edits = codeKey(selected, key, shift);
  return edits && applied(selected, edits);
};

describe("continueList", () => {
  it("starts the next item", () => {
    assert.strictEqual(listKey("- a|"), "- a\n- |");
    assert.strictEqual(listKey("  * a|"), "  * a\n  * |");
    assert.strictEqual(listKey("9. a|"), "9. a\n10. |");
    assert.strictEqual(listKey("1) a|"), "1) a\n2) |");
  });

  it("starts new tasks unchecked", () => {
    assert.strictEqual(listKey("- [x] a|"), "- [x] a\n- [ ] |");
  });

  it("ends the list on an empty item", () => {
    assert.strictEqual(listKey("- a\n- |"), "- a\n|");
  });

  it("keeps an empty item with text after the caret", () => {
    assert.strictEqual(listKey("- |b"), "- \n- |b");
  });

  it("leaves other lines and selections alone", () => {
    assert.isUndefined(listKey("plain|"));
    assert.isUndefined(continueList({ text: "- a", from: 0, to: 3 }));
  });
});

describe("codeKey", () => {
  it("leaves text outside code alone", () => {
    assert.isUndefined(onCode("plain|", "Enter"));
    assert.isUndefined(onCode("plain|", "ArrowDown"));
    assert.isUndefined(codeKey({ text: "```\na\n```", from: 0, to: 3 }, "Enter", false));
  });

  it("closes a block when Enter ends its opening fence", () => {
    assert.strictEqual(onCode("```ts|", "Enter"), "```ts\n|\n```");
    assert.strictEqual(onCode("~~~|", "Enter"), "~~~\n|\n~~~");
  });

  it("only adds a line on the opening fence of a closed block", () => {
    assert.strictEqual(onCode("```|\na\n```", "Enter"), "```\n|\na\n```");
  });

  it("adds a line inside a block", () => {
    assert.strictEqual(onCode("```\na|", "Enter"), "```\na\n|");
    assert.strictEqual(onCode("```\na|\n```", "Enter"), "```\na\n|\n```");
  });

  it("closes an open block from its empty last line", () => {
    assert.strictEqual(onCode("```\na\n|", "Enter"), "```\na\n```\n|");
  });

  it("closes an open block with Shift+Enter", () => {
    assert.strictEqual(onCode("```\na|", "Enter", true), "```\na\n```\n|");
  });

  it("leaves a closed block from its empty last line", () => {
    assert.strictEqual(onCode("```\na\n|\n```", "Enter"), "```\na\n```\n|");
  });

  it("leaves a closed block onto the empty line after it", () => {
    assert.strictEqual(onCode("```\na|\n```\n", "Enter", true), "```\na\n```\n|");
  });

  it("adds a line after a block that ends the text with Down, only there", () => {
    assert.strictEqual(onCode("```\na\n```|", "ArrowDown"), "```\na\n```\n|");
    assert.isUndefined(onCode("```\na|\n```", "ArrowDown"));
  });
});

describe("inserted paragraphs", () => {
  it("sets a paragraph apart from the text before it", () => {
    const edit = (text: string) => applied(at(text), [paragraphEdit(at(text), "new")]);
    assert.strictEqual(edit("|"), "new\n|");
    assert.strictEqual(edit("a|"), "a\n\nnew\n|");
    assert.strictEqual(edit("a\n|"), "a\n\nnew\n|");
    assert.strictEqual(edit("a\n\n|"), "a\n\nnew\n|");
  });

  it("quotes every line, in place of the selection", () => {
    assert.strictEqual(applied(at("|"), [quoteEdit(at("|"), "a\r\n\nb\n")]), "> a\n> \n> b\n\n|");
    assert.strictEqual(applied(at("x|"), [quoteEdit(at("x|"), "a")]), "x\n\n> a\n\n|");
    const selected: Selected = { text: "keep gone", from: 5, to: 9 };
    assert.deepStrictEqual(quoteEdit(selected, "a"), { from: 5, to: 9, text: "\n\n> a\n\n" });
  });
});
