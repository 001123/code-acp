import { FENCE, styleLines } from "./livePreview";

/** The editor's flat text and the selection as offsets in it. */
export interface Selected {
  text: string;
  from: number;
  to: number;
}

/** A change to the editor, in offsets of its text at that point. */
export type Edit = { from: number; to: number; text: string } | { caret: number };

/** Shift+Enter in a Markdown list item starts the next item; in an empty one, ends the list. Undefined elsewhere. */
export function continueList({ text, from: caret, to }: Selected): Edit | undefined {
  if (caret !== to) return undefined;
  const start = text.lastIndexOf("\n", caret - 1) + 1;
  const line = text.slice(start, caret);
  const m = /^(\s*)(?:([-*+])|(\d+)([.)]))(\s+)(\[[ xX]\]\s+)?/.exec(line);
  if (!m) return undefined;
  const end = text.indexOf("\n", caret);
  if (m[0].length === line.length && !text.slice(caret, end < 0 ? undefined : end).trim()) {
    return { from: start, to: caret, text: "" };
  }
  const marker = m[2] ?? `${Number(m[3]) + 1}${m[4]}`;
  return { from: caret, to: caret, text: `\n${m[1]}${marker}${m[5]}${m[6] ? "[ ] " : ""}` };
}

/** `added` in place of the selection, as a paragraph of its own. */
export function paragraphEdit({ text, from, to }: Selected, added: string): Edit {
  const before = text.slice(0, from);
  const lead = before.trim() ? (before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n") : "";
  return { from, to, text: `${lead}${added}\n` };
}

/** `quoted` in place of the selection, as a Markdown quote. */
export function quoteEdit({ text, from, to }: Selected, quoted: string): Edit {
  const before = text.slice(0, from);
  const lead = before && !before.endsWith("\n") ? "\n\n" : "";
  const lines = quoted.trimEnd().split(/\r?\n/).map((l) => (l ? `> ${l}` : "> ")).join("\n");
  return { from, to, text: `${lead}${lines}\n\n` };
}

/**
 * Enter in fenced code adds a line; on the opening fence it also closes the block. Shift+Enter, or Enter on the
 * block's empty last line, leaves it (closing it if open). Down on a block that ends the text adds a line after it.
 * Undefined when the key does nothing special here.
 */
export function codeKey({ text, from, to }: Selected, key: "Enter" | "ArrowDown", shift: boolean): Edit[] | undefined {
  if (from !== to) return undefined;
  const lines = text.split("\n");
  const styles = styleLines(lines);
  let i = 0;
  let start = 0;
  while (start + lines[i]!.length < from) start += lines[i++]!.length + 1;
  const { block, fence } = styles[i]!;
  if (fence === undefined) return undefined;
  const lineEnd = start + lines[i]!.length;
  const close = block === "fence-close" ? i : styles.findIndex((s, j) => j > i && s.block === "fence-close" && s.fence === fence);
  if (key === "ArrowDown") {
    return i === lines.length - 1 ? [{ from: text.length, to: text.length, text: "\n" }] : undefined;
  }
  const newline: Edit = { from, to: from, text: "\n" };
  if (block === "fence-open" && !shift) {
    if (close >= 0 || from !== lineEnd) return [newline];
    return [newline, { from: from + 1, to: from + 1, text: `\n${FENCE.exec(lines[i]!)![1]}` }, { caret: from + 1 }];
  }
  const emptyLast = block === "codeblock" && lines[i] === "" && (close < 0 ? i === lines.length - 1 : i === close - 1);
  if (!shift && !emptyLast && block !== "fence-close") return [newline];
  if (close < 0) {
    // The empty last line becomes the closing fence.
    const marker = FENCE.exec(lines[fence]!)![1];
    return [emptyLast ? { from: start, to: lineEnd, text: `${marker}\n` } : { from: lineEnd, to: lineEnd, text: `\n${marker}\n` }];
  }
  const edits: Edit[] = [];
  let closeEnd = lines.slice(0, close + 1).join("\n").length;
  if (emptyLast) {
    edits.push({ from: start - 1, to: lineEnd, text: "" });
    closeEnd -= lineEnd - start + 1;
  }
  edits.push(close + 1 < lines.length && lines[close + 1] === "" ? { caret: closeEnd + 1 } : { from: closeEnd, to: closeEnd, text: "\n" });
  return edits;
}
