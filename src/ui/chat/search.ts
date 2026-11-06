import type * as acp from "@agentclientprotocol/sdk";

/** Folds case and Vietnamese-style diacritics, so "tim kiem" finds "Tìm kiếm". */
const fold = (text: string) =>
  text.normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLocaleLowerCase();

/** Whether every word of `query` is in `text`. */
export function matchesText(text: string, query: string): boolean {
  const words = fold(query).split(/\s+/).filter(Boolean);
  const haystack = fold(text);
  return words.every((word) => haystack.includes(word));
}

/** Whether every word of `query` is in the session's title or folder. */
export const matchesSession = (session: acp.SessionInfo, query: string): boolean =>
  matchesText(`${session.title ?? ""} ${session.cwd}`, query);

/** Most matches `findMatches`' callers keep track of; a one-letter query in a long chat would find far more. */
export const MAX_MATCHES = 10_000;

function foldChar(char: string): string {
  const code = char.charCodeAt(0);
  if (code < 128) {
    if (code >= 65 && code <= 90) return String.fromCharCode(code + 32);
    // A soft line break in Markdown reads as a space.
    return code === 10 || code === 13 || code === 9 ? " " : char;
  }
  return fold(char);
}

/** `text` folded like `fold`, with, for each of its characters, where in `text` it came from; the last entry is `text`'s length. */
export function foldWithOffsets(text: string): { text: string; offsets: number[] } {
  const parts: string[] = [];
  const offsets: number[] = [];
  let at = 0;
  for (const char of text) {
    const folded = foldChar(char);
    parts.push(folded);
    for (let i = 0; i < folded.length; i++) offsets.push(at);
    at += char.length;
  }
  offsets.push(at);
  return { text: parts.join(""), offsets };
}

/** Where `query` is in `text`, ignoring case and diacritics, as offsets into `text`. */
export function findMatches(text: string, query: string, limit = MAX_MATCHES): { start: number; end: number }[] {
  const needle = foldWithOffsets(query).text;
  if (!needle) return [];
  const { text: haystack, offsets } = foldWithOffsets(text);
  const matches: { start: number; end: number }[] = [];
  for (
    let at = haystack.indexOf(needle);
    at >= 0 && matches.length < limit;
    at = haystack.indexOf(needle, at + needle.length)
  ) {
    // Up to the next character that folds to something: marks after the match belong to its last letter.
    let next = at + needle.length;
    while (next < haystack.length && offsets[next] === offsets[next - 1]) next++;
    matches.push({ start: offsets[at]!, end: offsets[next]! });
  }
  return matches;
}
