import { useState, useSyncExternalStore } from "react";
import { getState, setState } from "../vscode";
import { HISTORY_SORTS, type HistorySort } from "./historyList";

/** How the user left the sidebar; kept in the webview's state. */
export interface SidebarPrefs {
  /** Beside the conversation instead of over it on hover. */
  docked: boolean;
  sort: HistorySort;
  openCollapsed: boolean;
  historyCollapsed: boolean;
}

const read = (): SidebarPrefs => {
  const saved = ((getState() as { sidebar?: Partial<Record<keyof SidebarPrefs, unknown>> } | undefined)?.sidebar ?? {});
  return {
    docked: saved.docked === true,
    sort: HISTORY_SORTS.find((sort) => sort === saved.sort) ?? "updated",
    openCollapsed: saved.openCollapsed === true,
    historyCollapsed: saved.historyCollapsed === true,
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
