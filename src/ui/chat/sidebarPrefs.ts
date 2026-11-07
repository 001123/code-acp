import { useState, useSyncExternalStore } from "react";
import { getState, setState } from "../vscode";
import { HISTORY_SORTS, type HistorySort } from "./historyList";
import { TAB_SORTS, type TabSort } from "./tabRows";

/** How the user left the sidebar; kept in the webview's state. */
export interface SidebarPrefs {
  /** Beside the conversation instead of over it on hover. */
  docked: boolean;
  sort: HistorySort;
  tabSort: TabSort;
  historyCollapsed: boolean;
  workingCollapsed: boolean;
  waitingCollapsed: boolean;
}

const read = (): SidebarPrefs => {
  const saved = (getState() as { sidebar?: Partial<Record<keyof SidebarPrefs, unknown>> } | undefined)?.sidebar ?? {};
  return {
    docked: saved.docked === true,
    sort: HISTORY_SORTS.find((sort) => sort === saved.sort) ?? "updated",
    tabSort: TAB_SORTS.find((sort) => sort === saved.tabSort) ?? "manual",
    historyCollapsed: saved.historyCollapsed === true,
    workingCollapsed: saved.workingCollapsed === true,
    waitingCollapsed: saved.waitingCollapsed === true,
  };
};

export function useSidebarPrefs(): [SidebarPrefs, (patch: Partial<SidebarPrefs>) => void] {
  const [prefs, set] = useState(read);
  return [
    prefs,
    (patch) => {
      const next = { ...prefs, ...patch };
      set(next);
      setState({ ...(getState() as object | undefined), sidebar: next });
    },
  ];
}

/** Below this the conversation would be too narrow beside the sidebar: it opens over it, on hover. */
const DOCKABLE = window.matchMedia("(min-width: 560px)");

export const useDockable = () =>
  useSyncExternalStore(
    (changed) => {
      DOCKABLE.addEventListener("change", changed);
      return () => DOCKABLE.removeEventListener("change", changed);
    },
    () => DOCKABLE.matches,
  );
