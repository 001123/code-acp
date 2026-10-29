import type * as acp from "@agentclientprotocol/sdk";

/** Folds case and Vietnamese-style diacritics, so "tim kiem" finds "Tìm kiếm". */
const fold = (text: string) =>
  text.normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLocaleLowerCase();

/** Whether every word of `query` is in the session's title or folder. */
export function matchesSession(session: acp.SessionInfo, query: string): boolean {
  const words = fold(query).split(/\s+/).filter(Boolean);
  const haystack = fold(`${session.title ?? ""} ${session.cwd}`);
  return words.every((word) => haystack.includes(word));
}
