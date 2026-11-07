import type * as acp from "@agentclientprotocol/sdk";
import { useEffect, useRef, useState, type DragEvent, type MouseEvent } from "react";
import type {
  Attachment,
  BackgroundTask,
  ChangeHunk,
  ChangesMessage,
  PrDraft,
  QueuedInfo,
  TabGroupInfo,
  TabInfo,
  TerminalSnapshot,
  WorktreeDiff,
} from "../../chat/protocol";
import type { Totals } from "../../usageLedger";
import { Icon } from "../icon";
import { useL10n } from "../l10n";
import activityIcon from "@tabler/icons/outline/activity.svg";
import bellIcon from "@tabler/icons/outline/bell-ringing.svg";
import archiveIcon from "@tabler/icons/outline/archive.svg";
import chevronDownIcon from "@tabler/icons/outline/chevron-down.svg";
import chevronRightIcon from "@tabler/icons/outline/chevron-right.svg";
import gitBranchIcon from "@tabler/icons/outline/git-branch.svg";
import historyIcon from "@tabler/icons/outline/history.svg";
import undockIcon from "@tabler/icons/outline/layout-sidebar-right-collapse.svg";
import dockIcon from "@tabler/icons/outline/layout-sidebar-right-expand.svg";
import pinIcon from "@tabler/icons/outline/pin.svg";
import pinFilledIcon from "@tabler/icons/filled/pin.svg";
import plusIcon from "@tabler/icons/outline/plus.svg";
import xIcon from "@tabler/icons/outline/x.svg";
import { HISTORY_SORT_LABELS, HistoryList, SidebarSearch, SidebarSection, SortMenu, type History } from "./history";
import { HISTORY_SORTS } from "./historyList";
import { historyGroups } from "./historyList";
import { useClickMenu } from "./popupMenu";
import { post } from "./post";
import { useDockable, useSidebarPrefs } from "./sidebarPrefs";
import type { Usage } from "./usageMeter";
import type { AgentChoices } from "./agentPanel";
import {
  allRows,
  dropIndex,
  matchingRows,
  memberTitle,
  openRequests,
  requestsLabel,
  rowKey,
  rowsInHand,
  sortRows,
  sumChanges,
  sumRequests,
  tabChanges,
  tabRows,
  TAB_SORTS,
  tabWorking,
  waitingRowKeys,
  workingRowKeys,
  type ShownRow,
  type TabChanges,
} from "./tabRows";
import { EMPTY, type Transcript } from "./transcript";

export interface Status {
  text: string;
  busy?: boolean;
  /** Busy reopening the session, not with a turn. */
  loading?: boolean;
  needsLogin?: boolean;
  needsAgent?: boolean;
}

/** Everything the webview keeps per tab; the host only knows the session behind it. */
export interface TabState {
  transcript: Transcript;
  config: acp.SessionConfigOption[];
  /** The conversation started over: the options of its next session have yet to come. */
  configLoading?: boolean;
  usage?: Usage;
  /** Auto-compact window the host read from the agent's settings. */
  compactAt?: number;
  /** Tokens, cost and turns recorded for the session ("sessionTotals"). */
  totals?: Totals;
  status: Status;
  attachments: Attachment[];
  /** Slash commands the agent offers in this session. */
  commands: acp.AvailableCommand[];
  /** When the tab became busy; drives the elapsed time. */
  busySince?: number;
  /** Last session update while busy; a long silence shows the waiting row. */
  lastActivity?: number;
  /** The agent's terminals, by id. */
  terminals: Record<string, TerminalSnapshot>;
  changes?: ChangesMessage;
  /** The changes in the files whose changes were asked for, by path ("hunks"). */
  hunks?: Record<string, ChangeHunk[]>;
  /** Messages waiting for the running turn to end. */
  queue: QueuedInfo[];
  /** The turn whose user message the composer is editing. */
  editing?: number;
  /** What the tab's worktree changed, when it belongs to a group. */
  worktreeDiff?: WorktreeDiff;
  /** The pull request the user is about to open. */
  prDraft?: PrDraft;
  /** The work the agent runs in the background of the session ("backgroundTasks"). */
  backgroundTasks: BackgroundTask[];
}

export const NEW_TAB: TabState = {
  transcript: EMPTY,
  config: [],
  status: { text: "" },
  attachments: [],
  commands: [],
  terminals: {},
  queue: [],
  backgroundTasks: [],
};

export type TabsAction =
  | { type: "update"; tab: number; f: (state: TabState) => TabState }
  /** Drops the state of tabs that were closed. */
  | { type: "keep"; ids: number[] }
  /** A forked tab starts with the conversation of the tab it was forked from. */
  | { type: "fork"; from: number; tab: number };

export function tabStates(state: Record<number, TabState>, action: TabsAction): Record<number, TabState> {
  switch (action.type) {
    case "update":
      return { ...state, [action.tab]: action.f(state[action.tab] ?? NEW_TAB) };
    case "keep":
      return Object.fromEntries(action.ids.flatMap((id) => (state[id] ? [[id, state[id]]] : [])));
    case "fork": {
      const from = state[action.from] ?? NEW_TAB;
      const tab = state[action.tab] ?? NEW_TAB;
      return {
        ...state,
        [action.tab]: { ...tab, transcript: from.transcript, commands: from.commands, config: from.config },
      };
    }
  }
}

/** Drag data type of a tab being reordered; the view's file drop ignores it. */
export const TAB_DRAG_TYPE = "application/x-kd-code-tab";

export const isTabDrag = (e: { dataTransfer: DataTransfer | null }) =>
  e.dataTransfer?.types.includes(TAB_DRAG_TYPE) ?? false;

/** Tells tabs apart in the collapsed rail. */
const tabInitial = (title: string) => Array.from(title.trim())[0]?.toUpperCase() ?? "";

/** The lines changed, or the files when only binary ones changed. */
function ChangeCounts({ changes }: { changes: TabChanges }) {
  const { t } = useL10n();
  return (
    <span className="tab-changes">
      {changes.added + changes.removed === 0 ? (
        t("bestOf.files", changes.files)
      ) : (
        <>
          <span className="diff-added">+{changes.added}</span> <span className="diff-removed">−{changes.removed}</span>
        </>
      )}
    </span>
  );
}

/** What is being dragged, and the line it would drop at. */
type Dragged = { readonly ids: ReadonlyArray<number>; readonly group?: number };
type DropLine = { readonly key: string; readonly at: number; readonly after: boolean };

/**
 * The open tabs and the past conversations, as a rail beside the conversation that opens over it on hover (CSS);
 * `data-open` holds it open while a tab is dragged or renamed, or a search is under way. Docked, it stays open and
 * takes its room from the conversation. Everything past the rail's column is clipped while it is closed.
 */
export function TabSidebar({
  tabs,
  groups,
  states,
  active,
  shownGroup,
  agents,
  showChanges,
  onSelect,
  onSelectGroup,
  renaming,
  onRename,
  history,
  onNeedHistory,
  searchRequest,
  onLeaveSearch,
}: {
  tabs: TabInfo[];
  groups: TabGroupInfo[];
  states: Record<number, TabState>;
  active: number | undefined;
  /** The group whose comparison is shown, instead of the active tab. */
  shownGroup: number | undefined;
  agents: AgentChoices["agents"];
  /** kdCode.showChanges: counts the files awaiting review too. */
  showChanges: boolean;
  onSelect: (id: number) => void;
  onSelectGroup: (id: number) => void;
  /** The tab whose name is being edited; `onRename` starts or ends the edit. */
  renaming: number | undefined;
  onRename: (id: number | undefined) => void;
  history: History | undefined;
  /** The past conversations are about to be seen. */
  onNeedHistory: () => void;
  /** Counts the requests to go to the search box. */
  searchRequest: number;
  /** Escape left the search box. */
  onLeaveSearch: () => void;
}) {
  const { t, lang } = useL10n();
  const dateFormat = new Intl.DateTimeFormat(lang, { dateStyle: "medium", timeStyle: "short" });
  const panel = useRef<HTMLDivElement>(null);
  const [dragged, setDragged] = useState<Dragged>();
  const [dropLine, setDropLine] = useState<DropLine>();
  const [renamingGroup, setRenamingGroup] = useState<number>();
  const [query, setQuery] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const [prefs, setPrefs] = useSidebarPrefs();
  const dockable = useDockable();
  const sortMenu = useClickMenu();
  const tabSortMenu = useClickMenu();
  const searchInput = useRef<HTMLInputElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const restTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const workingKeys = useRef<ReadonlySet<string>>(new Set());
  const waitingKeys = useRef<ReadonlySet<string>>(new Set());
  const searching = query.trim() !== "";
  /** Dragging sets the manual order, which another order hides. */
  const reorderable = !searching && prefs.tabSort === "manual";
  const docked = prefs.docked && dockable;
  const inHand = rowsInHand(tabs, groups, { dragged: dragged?.ids, renaming, renamingGroup });
  const held = inHand || query !== "" || searchFocused || sortMenu.open || tabSortMenu.open || docked;
  const heldRef = useRef(held);
  heldRef.current = held;
  const needHistory = () => {
    if (searching || !prefs.historyCollapsed) onNeedHistory();
  };
  const titleOf = (tab: TabInfo, member: boolean) =>
    (member ? memberTitle(tab, agents) : tab.title) || t("chat.newTab");
  /** Results lead to a conversation, which ends the search. */
  const select = (id: number) => {
    setQuery("");
    onSelect(id);
  };
  const selectGroup = (id: number) => {
    setQuery("");
    onSelectGroup(id);
  };
  const endDrag = () => {
    setDragged(undefined);
    setDropLine(undefined);
  };
  const drop = (line: DropLine) => {
    if (!dragged) return;
    const index = dropIndex(tabs, dragged.ids, line.at);
    if (index === undefined) return;
    if (dragged.group !== undefined) post({ type: "moveGroup", group: dragged.group, index });
    else post({ type: "moveTab", tab: dragged.ids[0]!, index });
  };
  /** What a row needs to be dragged and dropped on; `ids` are the tabs it stands for. */
  /** A double click on a row's button is two clicks on that button: when they close rows, the next row is under the second. */
  const onRowDoubleClick = (rename: () => void) => (e: MouseEvent) => {
    if (!(e.target as Element).closest("button")) rename();
  };
  const dragProps = (key: string, ids: ReadonlyArray<number>, group: number | undefined) => {
    const first = tabs.findIndex((tab) => tab.id === ids[0]);
    return {
      onDragStart: (e: DragEvent) => {
        e.dataTransfer.setData(TAB_DRAG_TYPE, String(ids[0]));
        e.dataTransfer.effectAllowed = "move";
        setDragged({ ids, group });
      },
      onDragEnd: endDrag,
      onDragOver: (e: DragEvent) => {
        if (!isTabDrag(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        const box = e.currentTarget.getBoundingClientRect();
        const after = e.clientY > box.top + box.height / 2;
        if (dropLine?.key !== key || dropLine.after !== after)
          setDropLine({ key, after, at: first + (after ? ids.length : 0) });
      },
      onDrop: (e: DragEvent) => {
        if (!isTabDrag(e)) return;
        e.preventDefault();
        if (dropLine) drop(dropLine);
        endDrag();
      },
    };
  };
  const dropOf = (key: string) => (dropLine?.key === key ? (dropLine.after ? "after" : "before") : undefined);
  useEffect(() => {
    if (docked || searching) needHistory();
  }, [docked, searching]);
  useEffect(() => {
    if (searchRequest === 0) return;
    searchInput.current?.focus();
    if (scroller.current) scroller.current.scrollTop = 0;
  }, [searchRequest]);
  useEffect(() => () => clearTimeout(restTimer.current), []);
  /** The closed rail shows tabs only, so it goes back to them from wherever the list was scrolled to. */
  const backToTabs = () => {
    clearTimeout(restTimer.current);
    restTimer.current = setTimeout(() => {
      if (heldRef.current) return;
      const shown = panel.current?.querySelector("[data-active]") ?? null;
      if (scroller.current && !scroller.current.contains(shown)) scroller.current.scrollTop = 0;
      shown?.scrollIntoView({ block: "nearest" });
    }, 300);
  };

  const tabRow = (tab: TabInfo, member: boolean) => {
    const state = states[tab.id];
    const requests = requestsLabel(openRequests(state), t);
    const waiting = requests !== undefined;
    const changed = tabChanges(state, showChanges);
    const title = titleOf(tab, member);
    const tooltip = [
      waiting ? `${title} · ${requests}` : title,
      ...(!waiting && (state?.status.busy || tab.attempt === "running") ? [t("bestOf.running")] : []),
      ...(tab.createdAt === undefined ? [] : [t("chat.tabCreated", dateFormat.format(tab.createdAt))]),
      ...(tab.worktree ? [t("chat.tabWorktree", tab.worktree.branch ?? tab.worktree.root)] : []),
      ...(changed ? [t("chat.tabChanges", changed.files, changed.added, changed.removed)] : []),
    ].join("\n");
    // The counts have their own place in the row, so the date only shows without them.
    const meta =
      requests ??
      tab.worktree?.branch ??
      tab.worktree?.root ??
      (changed || tab.createdAt === undefined ? undefined : dateFormat.format(tab.createdAt));
    const pinLabel = t(tab.pinned ? "chat.unpinTab" : "chat.pinTab");
    // Closing a tab ends its session, not the conversation: that stays in the history.
    const closeLabel = t(tab.used ? "chat.archiveTab" : "chat.closeTab");
    const key = `tab-${tab.id}`;
    return (
      <div
        key={key}
        className="tab"
        role="tab"
        draggable={reorderable && tab.id !== renaming}
        aria-selected={tab.id === active && shownGroup === undefined}
        data-member={member || undefined}
        data-active={(tab.id === active && shownGroup === undefined) || undefined}
        data-busy={state?.status.busy || (state?.backgroundTasks.length ?? 0) > 0 || undefined}
        data-waiting={waiting || undefined}
        data-pinned={tab.pinned || undefined}
        data-dragging={dragged?.ids.includes(tab.id) || undefined}
        data-drop={dropOf(key)}
        title={tooltip}
        // Native context menu: the `webview/context` tab commands in package.json.
        data-vscode-context={JSON.stringify({
          webviewSection: "tab",
          tab: tab.id,
          tabPinned: tab.pinned,
          tabCanFork: tab.canFork,
          preventDefaultContextMenuItems: true,
        })}
        onClick={() => select(tab.id)}
        onDoubleClick={onRowDoubleClick(() => onRename(tab.id))}
        onAuxClick={(e) => {
          if (e.button === 1 && !tab.pinned) post({ type: "closeTab", tab: tab.id });
        }}
        {...dragProps(key, [tab.id], undefined)}
      >
        <span className="tab-marker" aria-hidden="true">
          <span className="tab-initial">{tabInitial(title)}</span>
          <span className="tab-dot" />
        </span>
        <span className="tab-text">
          {tab.id === renaming ? (
            <TabNameInput
              label={t("chat.renameTab")}
              // What the sidebar shows: the user's name, else the title. Clearing it drops the name.
              initial={member ? title : (tab.title ?? "")}
              onDone={(name) => {
                onRename(undefined);
                if (name !== undefined && name !== (member ? title : (tab.title ?? "")))
                  post({ type: "renameTab", tab: tab.id, title: name });
              }}
            />
          ) : (
            <span className="tab-title">{title}</span>
          )}
          {(meta !== undefined || changed) && (
            <span className="tab-meta">
              {tab.worktree && !waiting && <Icon svg={gitBranchIcon} />}
              {meta !== undefined && <span className="tab-meta-text">{meta}</span>}
              {changed && <ChangeCounts changes={changed} />}
            </span>
          )}
        </span>
        {/* A group's tabs are pinned together, from its row. */}
        {!member && (
          <button
            className="tab-pin"
            title={pinLabel}
            aria-label={pinLabel}
            aria-pressed={tab.pinned}
            onClick={(e) => {
              e.stopPropagation();
              post({ type: "pinTab", tab: tab.id, pinned: !tab.pinned });
            }}
          >
            <Icon svg={tab.pinned ? pinFilledIcon : pinIcon} />
          </button>
        )}
        {!tab.pinned && (
          <button
            className="tab-close"
            title={closeLabel}
            aria-label={closeLabel}
            onClick={(e) => {
              e.stopPropagation();
              post({ type: "closeTab", tab: tab.id });
            }}
          >
            <Icon svg={tab.used ? archiveIcon : xIcon} />
          </button>
        )}
      </div>
    );
  };

  const groupRow = (group: TabGroupInfo, members: TabInfo[], shown: TabInfo[]) => {
    const running = members.filter((tab) => states[tab.id]?.status.busy || tab.attempt === "running").length;
    const background = members.some((tab) => (states[tab.id]?.backgroundTasks.length ?? 0) > 0);
    const requests = requestsLabel(sumRequests(members.map((tab) => openRequests(states[tab.id]))), t);
    const waiting = requests !== undefined;
    const changed = sumChanges(members.flatMap((tab) => tabChanges(states[tab.id], showChanges) ?? []));
    const pinned = members[0]!.pinned;
    const key = `group-${group.id}`;
    const pinLabel = t(pinned ? "bestOf.unpinGroup" : "bestOf.pinGroup");
    const toggleLabel = t(group.collapsed ? "bestOf.expand" : "bestOf.collapse");
    const progress = t("bestOf.progress", members.length - running, members.length);
    return (
      <div key={key} className="tab-group" role="group">
        <div
          className="tab"
          role="tab"
          draggable={reorderable && group.id !== renamingGroup}
          aria-selected={group.id === shownGroup}
          data-group
          data-active={group.id === shownGroup || undefined}
          // With the rail closed, the group's row stands for the active tab among its own.
          data-current={members.some((tab) => tab.id === active) || undefined}
          data-busy={running > 0 || background || undefined}
          data-waiting={waiting || undefined}
          data-pinned={pinned || undefined}
          data-dragging={dragged?.group === group.id || undefined}
          data-drop={dropOf(key)}
          title={[
            group.title,
            progress,
            ...(requests === undefined ? [] : [requests]),
            ...(changed ? [t("chat.tabChanges", changed.files, changed.added, changed.removed)] : []),
          ].join("\n")}
          data-vscode-context={JSON.stringify({ webviewSection: "tabGroup", preventDefaultContextMenuItems: true })}
          onClick={() => selectGroup(group.id)}
          onDoubleClick={onRowDoubleClick(() => setRenamingGroup(group.id))}
          onAuxClick={(e) => {
            if (e.button === 1 && !pinned) post({ type: "closeGroup", group: group.id });
          }}
          {...dragProps(
            key,
            members.map((tab) => tab.id),
            group.id,
          )}
        >
          <span className="tab-marker" aria-hidden="true">
            <span className="tab-initial">{tabInitial(group.title)}</span>
            <span className="tab-dot" />
          </span>
          <span className="tab-text">
            {group.id === renamingGroup ? (
              <TabNameInput
                label={t("bestOf.rename")}
                initial={group.title}
                onDone={(name) => {
                  setRenamingGroup(undefined);
                  if (name !== undefined && name !== group.title)
                    post({ type: "renameGroup", group: group.id, title: name });
                }}
              />
            ) : (
              <span className="tab-title">{group.title}</span>
            )}
            <span className="tab-meta">
              <span className="tab-meta-text">{requests ?? progress}</span>
              {changed && <ChangeCounts changes={changed} />}
            </span>
          </span>
          <button
            className="tab-toggle"
            title={toggleLabel}
            aria-label={toggleLabel}
            aria-expanded={!group.collapsed}
            onClick={(e) => {
              e.stopPropagation();
              post({ type: "collapseGroup", group: group.id, collapsed: !group.collapsed });
            }}
          >
            <Icon svg={group.collapsed ? chevronRightIcon : chevronDownIcon} />
          </button>
          <button
            className="tab-pin"
            title={pinLabel}
            aria-label={pinLabel}
            aria-pressed={pinned}
            onClick={(e) => {
              e.stopPropagation();
              post({ type: "pinTab", tab: members[0]!.id, pinned: !pinned });
            }}
          >
            <Icon svg={pinned ? pinFilledIcon : pinIcon} />
          </button>
          {!pinned && (
            <button
              className="tab-close"
              title={t("bestOf.closeGroup")}
              aria-label={t("bestOf.closeGroup")}
              onClick={(e) => {
                e.stopPropagation();
                post({ type: "closeGroup", group: group.id });
              }}
            >
              <Icon svg={xIcon} />
            </button>
          )}
        </div>
        {(searching || !group.collapsed) && shown.map((tab) => tabRow(tab, true))}
      </div>
    );
  };

  const rows = sortRows(
    tabRows(tabs, groups),
    prefs.tabSort,
    (row) => (row.kind === "tab" ? (row.tab.title ?? "") : row.group.title),
    lang,
  );
  // A row keeps its section during a drag or a rename: moving it would end them.
  if (!inHand) {
    const waits = (tab: TabInfo) => requestsLabel(openRequests(states[tab.id]), t) !== undefined;
    workingKeys.current = workingRowKeys(rows, (tab) => tabWorking(tab, states[tab.id]), waits);
    waitingKeys.current = waitingRowKeys(rows, waits);
  }
  const shownRows = searching ? matchingRows(rows, query, titleOf) : allRows(rows);
  const isWorkingRow = (row: ShownRow) => !searching && workingKeys.current.has(rowKey(row));
  const isWaitingRow = (row: ShownRow) => !searching && waitingKeys.current.has(rowKey(row));
  const workingRows = shownRows.filter(isWorkingRow);
  const waitingRows = shownRows.filter(isWaitingRow);
  /** The section stays out of the way when collapsed, but the conversation on screen stays in the sidebar. */
  const isOnScreen = (row: ShownRow) =>
    row.kind === "tab"
      ? row.tab.id === active
      : row.group.id === shownGroup || row.members.some((tab) => tab.id === active);
  const shownRow = (row: ShownRow) =>
    row.kind === "tab" ? tabRow(row.tab, false) : groupRow(row.group, row.members, row.shown);
  useEffect(() => {
    panel.current?.querySelector("[data-active]")?.scrollIntoView({ block: "nearest" });
  }, [active, shownGroup, tabs.length, workingRows.length, waitingRows.length]);
  const past = historyGroups(history?.sessions ?? [], {
    openIds: new Set(tabs.flatMap((tab) => tab.sessionId ?? [])),
    query,
    sort: prefs.sort,
    lang,
  });
  const historyWaited = !history || (history.loading === true && history.sessions.length === 0);
  const noMatch = searching && shownRows.length === 0 && past.length === 0;
  const agentName = agents.find((each) => each.id === tabs.find((tab) => tab.id === active)?.agentId)?.name;
  const dockLabel = t(docked ? "chat.undockSidebar" : "chat.dockSidebar");
  const historySection = (
    <>
      {(!searching || past.length > 0) && (
        <SidebarSection
          icon={historyIcon}
          label={t("chat.sidebarHistory")}
          detail={agentName}
          collapsed={!searching && prefs.historyCollapsed}
          onToggle={() => {
            if (prefs.historyCollapsed) onNeedHistory();
            setPrefs({ historyCollapsed: !prefs.historyCollapsed });
          }}
        >
          <SortMenu
            menu={sortMenu}
            sort={prefs.sort}
            sorts={HISTORY_SORTS}
            labels={HISTORY_SORT_LABELS}
            label={t("chat.historySort")}
            onSort={(sort) => setPrefs({ sort })}
          />
        </SidebarSection>
      )}
      {(searching || !prefs.historyCollapsed) && (
        <HistoryList history={history} groups={past} searching={searching} onOpened={() => setQuery("")} />
      )}
    </>
  );
  return (
    <div
      id="tabs"
      data-open={held || undefined}
      data-docked={docked || undefined}
      onMouseEnter={() => {
        clearTimeout(restTimer.current);
        needHistory();
      }}
      onMouseLeave={backToTabs}
      onFocus={needHistory}
    >
      <div id="tab-panel" ref={panel}>
        <div id="tab-top">
          <SidebarSearch
            input={searchInput}
            query={query}
            onQuery={setQuery}
            onFocusChange={setSearchFocused}
            onLeave={() => {
              searchInput.current?.blur();
              onLeaveSearch();
            }}
          />
          <SortMenu
            id="tab-sort"
            menu={tabSortMenu}
            sort={prefs.tabSort}
            sorts={TAB_SORTS}
            labels={TAB_SORT_LABELS}
            label={t("chat.tabSort")}
            onSort={(tabSort) => setPrefs({ tabSort })}
          />
          {dockable && (
            <button
              className="icon-btn small"
              id="tab-dock"
              title={dockLabel}
              aria-label={dockLabel}
              aria-pressed={docked}
              onClick={() => setPrefs({ docked: !prefs.docked })}
            >
              <Icon svg={docked ? undockIcon : dockIcon} />
            </button>
          )}
        </div>
        {waitingRows.length > 0 && (
          <div id="tab-waiting">
            <SidebarSection
              icon={bellIcon}
              label={t("chat.sidebarWaiting")}
              detail={String(waitingRows.length)}
              collapsed={prefs.waitingCollapsed}
              onToggle={() => setPrefs({ waitingCollapsed: !prefs.waitingCollapsed })}
            />
            <div role="tablist">
              {(prefs.waitingCollapsed ? waitingRows.filter(isOnScreen) : waitingRows).map(shownRow)}
            </div>
          </div>
        )}
        <div id="tab-main">
          <div id="tab-scroll" ref={scroller}>
            <div id="tab-list" role="tablist">
              {shownRows.filter((row) => !isWorkingRow(row) && !isWaitingRow(row)).map(shownRow)}
            </div>
            {searching && historySection}
            {noMatch && (
              <div className="history-message">{t(historyWaited ? "chat.historyLoading" : "chat.historyNoMatch")}</div>
            )}
          </div>
          {!searching && (
            <div id="new-tab-row">
              <button id="new-tab" title={t("chat.newTab")} onClick={() => post({ type: "newTab" })}>
                <Icon svg={plusIcon} />
                <span id="new-tab-label">{t("chat.newTab")}</span>
              </button>
            </div>
          )}
        </div>
        {workingRows.length > 0 && (
          <div id="tab-working">
            <SidebarSection
              icon={activityIcon}
              label={t("chat.sidebarWorking")}
              detail={String(workingRows.length)}
              collapsed={prefs.workingCollapsed}
              onToggle={() => setPrefs({ workingCollapsed: !prefs.workingCollapsed })}
            />
            <div role="tablist">
              {(prefs.workingCollapsed ? workingRows.filter(isOnScreen) : workingRows).map(shownRow)}
            </div>
          </div>
        )}
        {!searching && <div id="tab-history">{historySection}</div>}
      </div>
    </div>
  );
}

const TAB_SORT_LABELS = {
  manual: "chat.tabSortManual",
  newest: "chat.tabSortNewest",
  oldest: "chat.tabSortOldest",
  title: "chat.tabSortTitle",
} as const;

/** Edits a name in place: Enter or leaving the field keeps it, Escape drops it (`undefined`). */
function TabNameInput({
  label,
  initial,
  onDone,
}: {
  label: string;
  initial: string;
  onDone: (name: string | undefined) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  const finish = (name: string | undefined) => {
    if (done.current) return;
    done.current = true;
    onDone(name);
  };
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  return (
    <input
      ref={input}
      className="tab-name"
      defaultValue={initial}
      aria-label={label}
      placeholder={label}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(e.currentTarget.value);
        else if (e.key === "Escape") finish(undefined);
      }}
      onBlur={(e) => finish(e.currentTarget.value)}
    />
  );
}
