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

/** A row as the sidebar shows it: a group may show only some of its tabs. */
export type ShownRow = { kind: "tab"; tab: TabInfo } | { kind: "group"; group: TabGroupInfo; members: TabInfo[]; shown: TabInfo[] };

/** The rows as they are. */
export const allRows = (rows: ReadonlyArray<TabRow>): ShownRow[] => rows.map((row) => (row.kind === "tab" ? row : { ...row, shown: row.members }));

export const rowKey = (row: TabRow | ShownRow) => (row.kind === "tab" ? `tab-${row.tab.id}` : `group-${row.group.id}`);

/** A turn is under way in the tab; reopening its session doesn't count. */
export const tabWorking = (tab: TabInfo, state: TabState | undefined) => (!!state?.status.busy && !state.status.loading) || tab.attempt === "running";

/** The rows of the sidebar's working section: something runs in them, and they are neither pinned nor waiting on the user. */
export function workingRowKeys(rows: ReadonlyArray<TabRow>, working: (tab: TabInfo) => boolean, waiting: (tab: TabInfo) => boolean): Set<string> {
  const isWorking = (members: ReadonlyArray<TabInfo>) => members.some(working) && !members.some((tab) => tab.pinned || waiting(tab));
  return new Set(rows.filter((row) => isWorking(row.kind === "tab" ? [row.tab] : row.members)).map(rowKey));
}

/** The rows matching `query`: a group whose title doesn't match shows just the tabs that do. `titleOf` names a tab, `member` when in a group. */
export function matchingRows(rows: ReadonlyArray<TabRow>, query: string, titleOf: (tab: TabInfo, member: boolean) => string): ShownRow[] {
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

/** The requests a tab's conversation waits on the user for, by kind. */
export interface OpenRequests {
  permissions: number;
  questions: number;
}

export function openRequests(state: TabState | undefined): OpenRequests {
  const open = state?.transcript.items.filter((item) => openRequest(item) !== undefined) ?? [];
  const permissions = open.filter((item) => item.kind === "permission").length;
  return { permissions, questions: open.length - permissions };
}

/** What the user is waited on for, in a few words; `undefined` when nothing is open. */
export function requestsLabel({ permissions, questions }: OpenRequests, t: Translate): string | undefined {
  const parts = [
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
