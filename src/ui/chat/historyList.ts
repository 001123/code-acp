import type * as acp from "@agentclientprotocol/sdk";
import { matchesSession } from "./search";

/** How the history is ordered. Sessions only tell their title, folder and last update. */
export type HistorySort = "updated" | "title" | "folder";

export const HISTORY_SORTS: ReadonlyArray<HistorySort> = ["updated", "title", "folder"];

/** A run of the history: all of it, or a folder's sessions when sorted by folder. */
export interface HistoryGroup {
  folder?: string;
  sessions: acp.SessionInfo[];
}

/** The last segment of a path, either way its separators lean. */
export const folderName = (cwd: string): string => cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? cwd;

const byUpdated = (a: acp.SessionInfo, b: acp.SessionInfo) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");

/** The sessions to list: none shown in a tab, those matching `query`, in the order of `sort`. Untitled ones sort last by title. */
export function historyGroups(
  sessions: ReadonlyArray<acp.SessionInfo>,
  { openIds, query, sort, lang }: { openIds: ReadonlySet<string>; query: string; sort: HistorySort; lang: string },
): HistoryGroup[] {
  const shown = sessions.filter((s) => !openIds.has(s.sessionId) && matchesSession(s, query)).sort(byUpdated);
  if (shown.length === 0) return [];
  const collator = new Intl.Collator(lang, { sensitivity: "base", numeric: true });
  if (sort === "updated") return [{ sessions: shown }];
  if (sort === "title") {
    const titleOf = (s: acp.SessionInfo) => s.title?.trim() ?? "";
    const titled = (s: acp.SessionInfo) => (titleOf(s) ? 0 : 1);
    return [{ sessions: [...shown].sort((a, b) => titled(a) - titled(b) || collator.compare(titleOf(a), titleOf(b))) }];
  }
  const folders = new Map<string, acp.SessionInfo[]>();
  for (const session of shown) folders.set(session.cwd, [...(folders.get(session.cwd) ?? []), session]);
  return [...folders.entries()]
    .sort(([a], [b]) => collator.compare(folderName(a), folderName(b)) || a.localeCompare(b))
    .map(([folder, each]) => ({ folder, sessions: each }));
}

/** "5 minutes ago" style label for an ISO timestamp. */
export function relativeTime(lang: string, iso: string | null | undefined): string {
  const time = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(time)) return "";
  const seconds = (time - Date.now()) / 1000;
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31536000],
    ["month", 2592000],
    ["week", 604800],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  const format = new Intl.RelativeTimeFormat(lang, { numeric: "auto" });
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
  }
  return format.format(0, "minute");
}

/** "5m" style label for an ISO timestamp, for a narrow row. No months: their narrow unit reads like minutes. */
export function shortTime(lang: string, iso: string | null | undefined, now = Date.now()): string {
  const time = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(time)) return "";
  const seconds = Math.abs(now - time) / 1000;
  const units: [string, number][] = [
    ["year", 31536000],
    ["week", 604800],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  const [unit, size] = units.find(([, each]) => seconds >= each) ?? ["minute", 60];
  return new Intl.NumberFormat(lang, { style: "unit", unit, unitDisplay: "narrow" }).format(Math.max(1, Math.floor(seconds / size)));
}
