/** How one line of composer Markdown is drawn: a block style for the whole line and styled ranges within it. */
export interface LineStyle {
  block?: "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "quote" | "fence-open" | "fence-close" | "codeblock" | "hr";
  spans: Span[];
  /** In fenced code: the index of the line that opens it. */
  fence?: number;
  /** Length of syntax that is always hidden, the caret kept after it: a heading's `#`s, a quote's `>`. */
  prefix?: number;
}

/**
 * A range of a line; `marker` is Markdown syntax, hidden while the caret is off the line or, with `around`, off the
 * inline construct (`**bold**`, a link) it delimits.
 */
export interface Span {
  from: number;
  to: number;
  kind: "marker" | "bullet" | "strong" | "em" | "strike" | "code" | "link";
  around?: { from: number; to: number };
}

export const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Styles for `lines`, Markdown typed in the composer. Only what reads line by line is styled: ATX headings, quotes,
 * lists, rules, fenced code and inline emphasis, code and links.
 */
export function styleLines(lines: readonly string[]): LineStyle[] {
  let fence: { marker: string; line: number } | undefined;
  return lines.map((line, i): LineStyle => {
    const open = FENCE.exec(line);
    const whole: Span[] = [{ from: 0, to: line.length, kind: "marker" }];
    if (fence) {
      const at = fence.line;
      if (open && open[1]![0] === fence.marker[0] && open[1]!.length >= fence.marker.length && !line.slice(open[0].length).trim()) {
        fence = undefined;
        return { block: "fence-close", spans: whole, fence: at };
      }
      return { block: "codeblock", spans: [], fence: at };
    }
    if (open) {
      fence = { marker: open[1]!, line: i };
      return { block: "fence-open", spans: whole, fence: i };
    }
    if (/^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(line)) return { block: "hr", spans: [{ from: 0, to: line.length, kind: "marker" }] };
    // The space is required so typing `#` alone (an issue number, say) doesn't hide it.
    const heading = /^ {0,3}(#{1,6})[ \t]+/.exec(line);
    if (heading) {
      const level = heading[1]!.length as 1 | 2 | 3 | 4 | 5 | 6;
      return { block: `h${level}`, prefix: heading[0].length, spans: inlineSpans(line, heading[0].length) };
    }
    // Like headings, a quote needs its space: a lone `>` stays text while it is typed.
    const quote = /^ {0,3}> /.exec(line);
    if (quote) return { block: "quote", prefix: quote[0].length, spans: inlineSpans(line, quote[0].length) };
    const item = /^\s*(?:[-*+]|\d{1,9}[.)])(?=\s)(?:\s+\[[ xX]\](?=\s))?/.exec(line);
    if (item) return { spans: [{ from: line.length - line.trimStart().length, to: item[0].length, kind: "bullet" }, ...inlineSpans(line, item[0].length)] };
    return { spans: inlineSpans(line, 0) };
  });
}

/** Emphasis, code spans and links in `line` from `start`. */
function inlineSpans(line: string, start: number): Span[] {
  const spans: Span[] = [];
  // Matched syntax is blanked out so later patterns don't match inside it.
  let text = " ".repeat(start) + line.slice(start);
  const blank = (from: number, to: number) => {
    text = text.slice(0, from) + "\0".repeat(to - from) + text.slice(to);
  };
  const scan = (re: RegExp, f: (m: RegExpExecArray) => void) => {
    for (const m of [...text.matchAll(re)]) f(m);
  };
  /** A delimited run: markers at both ends, `kind` between them. */
  const pair = (m: RegExpExecArray, kind: Span["kind"], keepInside: boolean) => {
    const open = m[1]!.length;
    const from = m.index;
    const to = from + m[0].length;
    const around = { from, to };
    spans.push({ from, to: from + open, kind: "marker", around }, { from: from + open, to: to - open, kind }, { from: to - open, to, kind: "marker", around });
    if (keepInside) {
      blank(from, from + open);
      blank(to - open, to);
    } else {
      blank(from, to);
    }
  };
  scan(/(`+)(?!`)(.+?)(?<!`)\1(?!`)/g, (m) => pair(m, "code", false));
  scan(/\[([^\]\0]+)\]\(([^)\s\0]+)\)/g, (m) => {
    const from = m.index;
    const textEnd = from + 1 + m[1]!.length;
    const around = { from, to: from + m[0].length };
    spans.push({ from, to: from + 1, kind: "marker", around }, { from: from + 1, to: textEnd, kind: "link" }, { from: textEnd, to: around.to, kind: "marker", around });
    blank(from, from + 1);
    blank(textEnd, from + m[0].length);
  });
  scan(/(\*\*|(?<![\p{L}\p{N}_])__)(?=[^\s\0])([^\0]+?)(?<=[^\s\0])\1/gu, (m) => {
    if (m[1] === "__" && /[\p{L}\p{N}_]/u.test(text[m.index + m[0].length] ?? "")) return;
    pair(m, "strong", true);
  });
  scan(/(~~)(?=[^\s\0])([^\0]+?)(?<=[^\s\0])~~/g, (m) => pair(m, "strike", true));
  scan(/(\*|(?<![\p{L}\p{N}_])_)(?=[^\s\0*_])([^\0]+?)(?<=[^\s\0*_])\1/gu, (m) => {
    if (m[1] === "_" && /[\p{L}\p{N}_]/u.test(text[m.index + m[0].length] ?? "")) return;
    pair(m, "em", true);
  });
  return spans.sort((a, b) => a.from - b.from);
}
