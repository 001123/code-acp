import { Extension, Node } from "@tiptap/core";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { UndoRedo } from "@tiptap/extensions";
import { Fragment, Slice, type Node as PmNode, type Schema } from "@tiptap/pm/model";
import { EditorState, Plugin, PluginKey, Selection, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { splitTokens } from "../markdown";
import { fenceLanguage, highlight } from "./highlight";
import { FENCE, styleLines, type LineStyle } from "./livePreview";

/*
 * The composer edits Markdown source: one paragraph per line, attachment tokens as atomic nodes. Decorations draw the
 * Markdown (headings, quotes, code, emphasis) and hide its syntax where the caret is not, so what is sent is
 * exactly what was typed.
 */

/** Stands for a token in flat text, so offsets in it match editor positions. */
export const TOKEN_CHAR = "￼";

/** A token to draw as a chip; images open in the lightbox. */
export interface TokenInfo {
  token: string;
  image?: boolean;
}

const TokenNode = Node.create({
  name: "token",
  group: "inline",
  inline: true,
  atom: true,
  selectable: false,
  addAttributes() {
    return {
      token: { default: "", parseHTML: (el) => el.getAttribute("data-token") ?? "", renderHTML: () => ({}) },
      image: { default: false, parseHTML: (el) => el.classList.contains("image"), renderHTML: () => ({}) },
    };
  },
  parseHTML() {
    return [{ tag: "mark[data-token]" }];
  },
  renderHTML({ node }) {
    return ["mark", { class: node.attrs.image ? "token image" : "token", "data-token": node.attrs.token, contenteditable: "false" }, node.attrs.token];
  },
  renderText({ node }) {
    return node.attrs.token;
  },
});

const livePreviewKey = new PluginKey<boolean>("livePreview");

const styleCache = new WeakMap<PmNode, LineStyle[]>();

/** The style of each line of `doc`. */
function stylesOf(doc: PmNode): LineStyle[] {
  let styles = styleCache.get(doc);
  if (!styles) {
    const lines: string[] = [];
    doc.forEach((line) => lines.push(lineText(line, true)));
    styles = styleLines(lines);
    styleCache.set(doc, styles);
  }
  return styles;
}

/** The line holding the empty selection: its index, start, style and the caret's offset in it. */
function caretLine(state: EditorState) {
  const { $head, empty } = state.selection;
  if (!empty || $head.depth !== 1) return undefined;
  const index = $head.index(0);
  return { index, start: $head.start(), size: $head.parent.content.size, style: stylesOf(state.doc)[index]!, offset: $head.parentOffset };
}

/** Backspace right after a hidden prefix removes it, turning a heading or quote back into text. */
function deletePrefix(view: EditorView): boolean {
  const at = caretLine(view.state);
  if (!at?.style.prefix || at.offset !== at.style.prefix) return false;
  view.dispatch(view.state.tr.delete(at.start, at.start + at.style.prefix));
  return true;
}

/** Draws the Markdown; `placeholder` shows while the composer is empty. */
const LivePreview = Extension.create<{ placeholder: () => string }>({
  name: "livePreview",
  addOptions() {
    return { placeholder: () => "" };
  },
  addProseMirrorPlugins() {
    const { placeholder } = this.options;
    return [
      new Plugin<boolean>({
        key: livePreviewKey,
        state: {
          init: () => false,
          apply: (tr, focused) => tr.getMeta(livePreviewKey) ?? focused,
        },
        // Keeps the caret out of a hidden prefix: after it, or before the line when moving left out of it.
        appendTransaction(trs, old, state) {
          if (!trs.some((tr) => tr.selectionSet || tr.docChanged)) return null;
          const at = caretLine(state);
          if (!at) return null;
          const { index, start, offset, style } = at;
          const moved = !trs.some((tr) => tr.docChanged) && old.selection.empty ? old.selection.head - start : undefined;
          const prefix = style.prefix ?? 0;
          if (offset < prefix) {
            const leaving = moved === prefix && index > 0;
            return state.tr.setSelection(TextSelection.create(state.doc, leaving ? start - 2 : start + prefix));
          }
          return null;
        },
        props: {
          handleKeyDown(view, event) {
            return event.key === "Backspace" && !event.metaKey && !event.ctrlKey && !event.altKey && deletePrefix(view);
          },
          handleDOMEvents: {
            focus: (view) => (view.dispatch(view.state.tr.setMeta(livePreviewKey, true)), false),
            blur: (view) => (view.dispatch(view.state.tr.setMeta(livePreviewKey, false)), false),
          },
          decorations(state) {
            const { doc, selection } = state;
            const focused = livePreviewKey.getState(state);
            const decorations: Decoration[] = [];
            if (doc.childCount === 1 && doc.firstChild!.content.size === 0) {
              decorations.push(Decoration.node(0, 2, { class: "md-placeholder", "data-placeholder": placeholder() }));
            }
            const styles = stylesOf(doc);
            // Lines the selection touches; a fenced block counts as one line.
            const touched = new Set<number>();
            const starts: number[] = [];
            doc.forEach((line, offset, i) => {
              starts.push(offset + 1);
              if (focused && selection.from <= offset + 1 + line.content.size && selection.to >= offset + 1) touched.add(styles[i]!.fence ?? -1 - i);
            });
            styles.forEach((style, i) => {
              const line = doc.child(i);
              const start = starts[i]!;
              const active = touched.has(style.fence ?? -1 - i);
              if (style.block) {
                const attrs: Record<string, string> = { class: `md-${style.block}` };
                if (!active && (style.block === "fence-open" || style.block === "fence-close")) {
                  attrs.class += " md-collapsed";
                  const lang = style.block === "fence-open" && fenceLanguage(lineText(line, true).replace(FENCE, ""));
                  if (lang) attrs["data-lang"] = lang.name;
                }
                decorations.push(Decoration.node(start - 1, start - 1 + line.nodeSize, attrs));
              }
              if (style.prefix) decorations.push(Decoration.inline(start, start + style.prefix, { class: "md-prefix" }));
              for (const span of style.spans) {
                if (span.from === span.to) continue;
                // Inline syntax shows while the selection touches its construct, other markers while it touches the line.
                const shown = span.around ? focused && selection.from <= start + span.around.to && selection.to >= start + span.around.from : active;
                const cls = span.kind === "marker" ? (shown ? "md-marker" : "md-marker md-hidden") : `md-${span.kind}`;
                decorations.push(Decoration.inline(start + span.from, start + span.to, { class: cls }));
              }
              if (style.block === "fence-open") decorations.push(...codeDecorations(doc, styles, starts, i));
            });
            return DecorationSet.create(doc, decorations);
          },
        },
      }),
    ];
  },
});

/** Syntax colors for the code of the fenced block opened on line `open`. */
function codeDecorations(doc: PmNode, styles: readonly LineStyle[], starts: readonly number[], open: number): Decoration[] {
  const lang = fenceLanguage(lineText(doc.child(open), true).replace(FENCE, ""));
  if (!lang) return [];
  const lines: number[] = [];
  for (let i = open + 1; styles[i]?.block === "codeblock"; i++) lines.push(i);
  if (!lines.length) return [];
  const tokens = highlight(lang.grammar, lines.map((i) => lineText(doc.child(i), true)).join("\n"));
  return lines.flatMap((line, n) =>
    (tokens[n] ?? []).map((t) => Decoration.inline(starts[line]! + t.from, starts[line]! + t.to, { style: t.style })),
  );
}

/** The extensions of the composer editor. */
export function composerExtensions(placeholder: () => string) {
  return [Document, Paragraph, Text, TokenNode, UndoRedo, LivePreview.configure({ placeholder })];
}

/** A line's text; with `flat`, each token is one `TOKEN_CHAR`. */
function lineText(line: PmNode, flat: boolean): string {
  let text = "";
  line.forEach((child) => {
    text += child.isText ? child.text! : flat ? TOKEN_CHAR : (child.attrs.token as string);
  });
  return text;
}

/** The Markdown in the editor, tokens as their text. */
export function textOf(doc: PmNode): string {
  const lines: string[] = [];
  doc.forEach((line) => lines.push(lineText(line, false)));
  return lines.join("\n");
}

/** The tokens drawn in the editor. */
export function tokensIn(doc: PmNode): Set<string> {
  const tokens = new Set<string>();
  doc.descendants((node) => {
    if (node.type.name === "token") tokens.add(node.attrs.token);
  });
  return tokens;
}

/** The editor text with each token as one `TOKEN_CHAR`: offsets in it convert to positions with `posAt`. */
export function flatText(doc: PmNode): string {
  const lines: string[] = [];
  doc.forEach((line) => lines.push(lineText(line, true)));
  return lines.join("\n");
}

/** The editor position of `offset` in `flatText`. */
export function posAt(doc: PmNode, offset: number): number {
  let pos = 0;
  let left = offset;
  for (let i = 0; i < doc.childCount; i++) {
    const line = doc.child(i);
    if (left <= line.content.size) return pos + 1 + left;
    left -= line.content.size + 1;
    pos += line.nodeSize;
  }
  return doc.content.size - 1;
}

/** The offset in `flatText` of editor position `pos`. */
export function offsetAt(doc: PmNode, pos: number): number {
  let at = 0;
  let start = 0;
  for (let i = 0; i < doc.childCount; i++) {
    const line = doc.child(i);
    if (pos <= start + line.nodeSize - 1) return at + Math.max(0, Math.min(pos - start - 1, line.content.size));
    at += line.content.size + 1;
    start += line.nodeSize;
  }
  return at - 1;
}

/** Lines of `text` as paragraphs, the first occurrence of each of `tokens` as a token node. */
function linesOf(schema: Schema, text: string, tokens: readonly TokenInfo[]): Fragment {
  const left = [...tokens];
  return Fragment.fromArray(
    text.split("\n").map((line) => {
      const parts = splitTokens(line, left);
      const nodes = parts.flatMap((part) => {
        if (typeof part === "string") return part ? [schema.text(part)] : [];
        left.splice(left.indexOf(part), 1);
        return [schema.nodes.token!.create({ token: part.token, image: !!part.image })];
      });
      return schema.nodes.paragraph!.create(null, nodes);
    }),
  );
}

/** Replaces `from`..`to` (offsets in `flatText`) with `text`, its `tokens` as chips; the caret goes after it. */
export function replaceText(view: EditorView, from: number, to: number, text: string, tokens: readonly TokenInfo[] = []): void {
  const { state } = view;
  const end = posAt(state.doc, to);
  const tr = state.tr.replace(posAt(state.doc, from), end, new Slice(linesOf(state.schema, text, tokens), 1, 1));
  tr.setSelection(TextSelection.create(tr.doc, tr.mapping.map(end)));
  view.dispatch(tr.scrollIntoView());
}

/** Puts `text` in the editor with a fresh undo history, the caret at the end. */
export function resetText(view: EditorView, text: string, tokens: readonly TokenInfo[]): void {
  const { schema, plugins } = view.state;
  const doc = schema.nodes.doc!.create(null, linesOf(schema, text, tokens));
  view.updateState(EditorState.create({ doc, plugins, selection: Selection.atEnd(doc) }));
  if (view.hasFocus()) view.dispatch(view.state.tr.setMeta(livePreviewKey, true));
}

/** Puts the caret at `offset` in `flatText`. */
export function setCaret(view: EditorView, offset: number): void {
  const { state } = view;
  view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, posAt(state.doc, offset))).scrollIntoView());
}
