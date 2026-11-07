import type { TabGroupInfo, TabInfo, WorktreeDiff } from "../../chat/protocol";
import type { Translate } from "../l10n";
import type { AgentChoices } from "./agentPanel";
import type { TabState } from "./tabs";
import { matchesText } from "./search";
import { openRequest } from "./transcript";

/** A row of the sidebar: a tab on its own, or a group with its tabs, which come next to each other. */
export type TabRow = { kind: "tab"; tab: TabInfo } | { kind: "group"; group: TabGroupInfo; members: TabInfo[] };

/** The sidebar's rows, in the tabs' order. A tab whose group isn't known stands on its own. */
export function tabRows(tabs: ReadonlyArray<TabInfo>, groups: ReadonlyArray<TabGroupInfo>): TabRow[] {
  const rows: TabRow[] = [];
  for (const tab of tabs) {
    const group = groups.find((each) => each.id === tab.group);
    const last = rows.at(-1);
    if (!group) rows.push({ kind: "tab", tab });
    else if (last?.kind === "group" && last.group.id === group.id) last.members.push(tab);
    else rows.push({ kind: "group", group, members: [tab] });
  }
  return rows;
}

/** How the sidebar orders the tabs: as the user dragged them, or by when they started or what they're called. */
export type TabSort = "manual" | "newest" | "oldest" | "title";

export const TAB_SORTS: ReadonlyArray<TabSort> = ["manual", "newest", "oldest", "title"];

/**
 * The rows in the order of `sort`. Pinned rows stay first, and a group keeps its tabs. A group started when its first
 * tab did; rows that haven't started, or have no title, come last, in the order they were in.
 */
export function sortRows(
  rows: ReadonlyArray<TabRow>,
  sort: TabSort,
  titleOf: (row: TabRow) => string,
  lang: string,
): TabRow[] {
  if (sort === "manual") return [...rows];
  const membersOf = (row: TabRow) => (row.kind === "tab" ? [row.tab] : row.members);
  const pinned = (row: TabRow) => (membersOf(row)[0]!.pinned ? 0 : 1);
  const started = (row: TabRow) => {
    const times = membersOf(row).flatMap((tab) => tab.createdAt ?? []);
    return times.length === 0 ? undefined : Math.min(...times);
  };
  const collator = new Intl.Collator(lang, { sensitivity: "base", numeric: true });
  const compare = (a: TabRow, b: TabRow): number => {
    if (sort === "title") {
      const [x, y] = [titleOf(a).trim(), titleOf(b).trim()];
      return (x ? 0 : 1) - (y ? 0 : 1) || (x && y ? collator.compare(x, y) : 0);
    }
    const [x, y] = [started(a), started(b)];
    if (x === undefined || y === undefined) return (x === undefined ? 1 : 0) - (y === undefined ? 1 : 0);
    return sort === "newest" ? y - x : x - y;
  };
  return [...rows].sort((a, b) => pinned(a) - pinned(b) || compare(a, b));
}

/** A row as the sidebar shows it: a group may show only some of its tabs. */
export type ShownRow =
  { kind: "tab"; tab: TabInfo } | { kind: "group"; group: TabGroupInfo; members: TabInfo[]; shown: TabInfo[] };

/** The rows as they are. */
export const allRows = (rows: ReadonlyArray<TabRow>): ShownRow[] =>
  rows.map((row) => (row.kind === "tab" ? row : { ...row, shown: row.members }));

export const rowKey = (row: TabRow | ShownRow) => (row.kind === "tab" ? `tab-${row.tab.id}` : `group-${row.group.id}`);

/** A turn is under way in the tab, or the agent runs something in its background; reopening its session doesn't count. */
export const tabWorking = (tab: TabInfo, state: TabState | undefined) =>
  (!!state?.status.busy && !state.status.loading) ||
  tab.attempt === "running" ||
  (state?.backgroundTasks.length ?? 0) > 0;

/** The rows of the sidebar's working section: something runs in them, and they are neither pinned nor waiting on the user. */
export function workingRowKeys(
  rows: ReadonlyArray<TabRow>,
  working: (tab: TabInfo) => boolean,
  waiting: (tab: TabInfo) => boolean,
): Set<string> {
  const isWorking = (members: ReadonlyArray<TabInfo>) =>
    members.some(working) && !members.some((tab) => tab.pinned || waiting(tab));
  return new Set(rows.filter((row) => isWorking(row.kind === "tab" ? [row.tab] : row.members)).map(rowKey));
}

/** The rows of the sidebar's waiting section: one of their tabs waits on the user, and they aren't pinned. */
export function waitingRowKeys(rows: ReadonlyArray<TabRow>, waiting: (tab: TabInfo) => boolean): Set<string> {
  const isWaiting = (members: ReadonlyArray<TabInfo>) => members.some(waiting) && !members.some((tab) => tab.pinned);
  return new Set(rows.filter((row) => isWaiting(row.kind === "tab" ? [row.tab] : row.members)).map(rowKey));
}

/** What a drag or a rename is on, by id. */
export interface RowsInHand {
  dragged?: ReadonlyArray<number> | undefined;
  renaming?: number | undefined;
  renamingGroup?: number | undefined;
}

/** Whether a drag or a rename is under way. A row that goes takes its drag or name input along, and neither says it ended, so one on rows now gone is over. */
export function rowsInHand(
  tabs: ReadonlyArray<TabInfo>,
  groups: ReadonlyArray<TabGroupInfo>,
  { dragged, renaming, renamingGroup }: RowsInHand,
): boolean {
  const isTab = (id: number) => tabs.some((tab) => tab.id === id);
  return (
    dragged?.some(isTab) === true ||
    (renaming !== undefined && isTab(renaming)) ||
    groups.some((group) => group.id === renamingGroup)
  );
}

/** The rows matching `query`: a group whose title doesn't match shows just the tabs that do. `titleOf` names a tab, `member` when in a group. */
export function matchingRows(
  rows: ReadonlyArray<TabRow>,
  query: string,
  titleOf: (tab: TabInfo, member: boolean) => string,
): ShownRow[] {
  const matches = (tab: TabInfo, member: boolean) => matchesText(`${titleOf(tab, member)} ${tab.cwd}`, query);
  return allRows(rows).flatMap((row): ShownRow[] => {
    if (row.kind === "tab") return matches(row.tab, false) ? [row] : [];
    const shown = matchesText(row.group.title, query) ? row.members : row.members.filter((tab) => matches(tab, true));
    return shown.length > 0 ? [{ ...row, shown }] : [];
  });
}

/** Where tabs being moved end up, for a drop line at position `at` of the tabs as they are. */
export function dropIndex(tabs: ReadonlyArray<TabInfo>, moved: ReadonlyArray<number>, at: number): number | undefined {
  const from = tabs.findIndex((tab) => tab.id === moved[0]);
  if (from < 0) return undefined;
  const index = from < at ? at - moved.length : at;
  return index === from ? undefined : index;
}

/** What a tab of a group is called: its agent with the model and effort picked for it, unless the user named it. */
export function memberTitle(tab: TabInfo, agents: AgentChoices["agents"]): string {
  if (tab.named) return tab.title ?? "";
  const agent = agents.find((each) => each.id === tab.agentId)?.name;
  if (agent === undefined) return tab.title ?? "";
  return tab.attemptLabel ? `${agent} · ${tab.attemptLabel}` : agent;
}

/** Lines added and removed in all the files of `diff`. */
export function diffTotals(diff: WorktreeDiff): { added: number; removed: number } {
  return {
    added: diff.files.reduce((sum, file) => sum + (file.added ?? 0), 0),
    removed: diff.files.reduce((sum, file) => sum + (file.removed ?? 0), 0),
  };
}

/** What a tab waits on the user for, by kind: requests in its conversation, and a login its agent needs. */
export interface OpenRequests {
  permissions: number;
  questions: number;
  /** Tabs whose agent needs the user to log in. */
  logins: number;
}

export const NO_REQUESTS: OpenRequests = { permissions: 0, questions: 0, logins: 0 };

export function openRequests(state: TabState | undefined): OpenRequests {
  const open = state?.transcript.items.filter((item) => openRequest(item) !== undefined) ?? [];
  const permissions = open.filter((item) => item.kind === "permission").length;
  return { permissions, questions: open.length - permissions, logins: state?.status.needsLogin ? 1 : 0 };
}

/** The requests of several tabs together. */
export const sumRequests = (each: ReadonlyArray<OpenRequests>): OpenRequests =>
  each.reduce(
    (sum, one) => ({
      permissions: sum.permissions + one.permissions,
      questions: sum.questions + one.questions,
      logins: sum.logins + one.logins,
    }),
    NO_REQUESTS,
  );

/** What the user is waited on for, in a few words; `undefined` when nothing is open. */
export function requestsLabel({ permissions, questions, logins }: OpenRequests, t: Translate): string | undefined {
  const parts = [
    ...(logins === 0 ? [] : [t("chat.tabLogin")]),
    ...(permissions === 0 ? [] : [permissions === 1 ? t("chat.tabPermission") : t("chat.tabPermissions", permissions)]),
    ...(questions === 0 ? [] : [questions === 1 ? t("chat.tabQuestion") : t("chat.tabQuestions", questions)]),
  ];
  return parts.length === 0 ? undefined : parts.join(" · ");
}

/** How many files a tab changed, and the lines in them. */
export interface TabChanges {
  files: number;
  added: number;
  removed: number;
}

/**
 * What a tab changed: its worktree's diff when it belongs to a group, else the files awaiting review, which
 * codeAcp.showChanges can hide. `undefined` when there is nothing to show.
 */
export function tabChanges(state: TabState | undefined, showChanges: boolean): TabChanges | undefined {
  const diff = state?.worktreeDiff;
  const files = diff && !diff.error ? diff.files : showChanges ? state?.changes?.files : undefined;
  return files?.length ? { files: files.length, ...diffTotals({ files }) } : undefined;
}

/** All of `changes` together; `undefined` when there are none. */
export function sumChanges(changes: ReadonlyArray<TabChanges>): TabChanges | undefined {
  if (changes.length === 0) return undefined;
  return {
    files: changes.reduce((sum, each) => sum + each.files, 0),
    added: changes.reduce((sum, each) => sum + each.added, 0),
    removed: changes.reduce((sum, each) => sum + each.removed, 0),
  };
}

/** Where one tab of a group stands, in the words of the comparison. */
export function attemptStatus(tab: TabInfo, state: TabState | undefined): Parameters<Translate>[0] {
  if (state?.transcript.items.some((item) => openRequest(item) !== undefined)) return "bestOf.waiting";
  if (state?.status.busy || tab.attempt === "running") return "bestOf.running";
  if (tab.applied) return "bestOf.applied";
  return tab.attempt === "failed" ? "bestOf.failed" : "bestOf.done";
}
