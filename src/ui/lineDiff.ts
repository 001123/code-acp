/** Line diffs for the chat's diff view and the changed-files counts; no imports, so host and webview share it. */

export interface DiffLine {
  type: "ctx" | "add" | "del";
  text: string;
  /** 1-based line in the old text (ctx, del) or the new one (add). */
  line: number;
}

/** A run of changed lines with context around them. */
export interface Hunk {
  lines: DiffLine[];
}

/** Above this many cells the LCS table gets too big: the changed middle shows as removed, then added. */
const MAX_CELLS = 2_500_000;

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  // A final newline ends the last line rather than starting an empty one.
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Line-by-line edit script from `before` to `after` (null: the file did not exist). */
export function diffLines(before: string | null | undefined, after: string): DiffLine[] {
  return editScript(splitLines(before ?? ""), splitLines(after));
}

function editScript(a: ReadonlyArray<string>, b: ReadonlyArray<string>): DiffLine[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const out: DiffLine[] = [];
  for (let i = 0; i < start; i++) out.push({ type: "ctx", text: a[i]!, line: i + 1 });
  const n = endA - start;
  const m = endB - start;
  if (n > 0 && m > 0 && n * m <= MAX_CELLS) {
    // lcs[i * (m + 1) + j]: longest common subsequence of a[start + i..] and b[start + j..].
    const w = m + 1;
    const lcs = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * w + j] =
          a[start + i] === b[start + j] ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[start + i] === b[start + j]) {
        out.push({ type: "ctx", text: a[start + i]!, line: start + i + 1 });
        i++;
        j++;
      } else if (i < n && (j === m || lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!)) {
        // Removed lines first, as in unified diffs.
        out.push({ type: "del", text: a[start + i]!, line: start + i + 1 });
        i++;
      } else {
        out.push({ type: "add", text: b[start + j]!, line: start + j + 1 });
        j++;
      }
    }
  } else {
    for (let i = start; i < endA; i++) out.push({ type: "del", text: a[i]!, line: i + 1 });
    for (let j = start; j < endB; j++) out.push({ type: "add", text: b[j]!, line: j + 1 });
  }
  for (let i = endA; i < a.length; i++) out.push({ type: "ctx", text: a[i]!, line: i + 1 });
  return out;
}

/** Lines added and removed. */
export function diffStats(lines: ReadonlyArray<DiffLine>): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.type === "add") added++;
    else if (l.type === "del") removed++;
  }
  return { added, removed };
}

/** The changes with `context` unchanged lines around each; changes closer than twice that share a hunk. */
export function hunks(lines: ReadonlyArray<DiffLine>, context = 3): Hunk[] {
  const out: Hunk[] = [];
  let current: DiffLine[] | undefined;
  let lastChange = -Infinity;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.type === "ctx") continue;
    if (current && i - lastChange <= 2 * context + 1) {
      current.push(...lines.slice(lastChange + 1, i + 1));
    } else {
      if (current) current.push(...lines.slice(lastChange + 1, Math.min(lines.length, lastChange + 1 + context)));
      current = [...lines.slice(Math.max(0, i - context), i + 1)];
      out.push({ lines: current });
    }
    lastChange = i;
  }
  if (current) current.push(...lines.slice(lastChange + 1, Math.min(lines.length, lastChange + 1 + context)));
  return out;
}

/** A run of changed lines with no unchanged line in it; `oldStart` and `newStart` are 0-based line indexes. */
export interface ChangeBlock {
  oldStart: number;
  newStart: number;
  removed: string[];
  added: string[];
}

/**
 * The changes from `before` to `after`, each one reviewable alone. Lines are split on "\n" alone and the empty line
 * after a final newline counts, so that applying blocks gives back the exact text, line endings included.
 */
export function changeBlocks(before: string, after: string): ChangeBlock[] {
  const blocks: ChangeBlock[] = [];
  let current: ChangeBlock | undefined;
  let oldAt = 0;
  let newAt = 0;
  for (const l of editScript(before.split("\n"), after.split("\n"))) {
    if (l.type === "ctx") {
      current = undefined;
      oldAt++;
      newAt++;
      continue;
    }
    if (!current) {
      current = { oldStart: oldAt, newStart: newAt, removed: [], added: [] };
      blocks.push(current);
    }
    if (l.type === "del") {
      current.removed.push(l.text);
      oldAt++;
    } else {
      current.added.push(l.text);
      newAt++;
    }
  }
  return blocks;
}

function spliceLines(text: string, start: number, count: number, lines: ReadonlyArray<string>): string {
  const all = text.split("\n");
  return [...all.slice(0, start), ...lines, ...all.slice(start + count)].join("\n");
}

/** `before` with the change `block` made to it. */
export function keepBlock(before: string, block: ChangeBlock): string {
  return spliceLines(before, block.oldStart, block.removed.length, block.added);
}

/** `after` with the change `block` taken out of it. */
export function undoBlock(after: string, block: ChangeBlock): string {
  return spliceLines(after, block.newStart, block.added.length, block.removed);
}

export function sameBlock(a: ChangeBlock, b: ChangeBlock): boolean {
  const same = (x: ReadonlyArray<string>, y: ReadonlyArray<string>) => x.length === y.length && x.every((l, i) => l === y[i]);
  return a.oldStart === b.oldStart && a.newStart === b.newStart && same(a.removed, b.removed) && same(a.added, b.added);
}

/** Whether offset `i` falls inside a line ending or a surrogate pair. */
function splitsCharacter(s: string, i: number): boolean {
  return i > 0 && i < s.length && ((s[i - 1] === "\r" && s[i] === "\n") || (s.charCodeAt(i - 1) & 0xfc00) === 0xd800);
}

/** The smallest edit that turns `text` into `next`, so an editor keeps its cursor and scroll position. */
export function replacement(text: string, next: string): { start: number; end: number; insert: string } {
  const shortest = Math.min(text.length, next.length);
  let start = 0;
  while (start < shortest && text[start] === next[start]) start++;
  while (splitsCharacter(text, start) || splitsCharacter(next, start)) start--;
  let suffix = 0;
  while (suffix < shortest - start && text[text.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix++;
  while (splitsCharacter(text, text.length - suffix) || splitsCharacter(next, next.length - suffix)) suffix--;
  return { start, end: text.length - suffix, insert: next.slice(start, next.length - suffix) };
}
