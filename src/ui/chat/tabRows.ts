import type { TabGroupInfo, TabInfo, WorktreeDiff } from "../../chat/protocol";
import type { Translate } from "../l10n";
import type { AgentChoices } from "./agentPanel";
import type { TabState } from "./tabs";
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

/** Where one tab of a group stands, in the words of the comparison. */
export function attemptStatus(tab: TabInfo, state: TabState | undefined): Parameters<Translate>[0] {
  if (state?.transcript.items.some((item) => openRequest(item) !== undefined)) return "bestOf.waiting";
  if (state?.status.busy || tab.attempt === "running") return "bestOf.running";
  if (tab.applied) return "bestOf.applied";
  return tab.attempt === "failed" ? "bestOf.failed" : "bestOf.done";
}
