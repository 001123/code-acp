import type * as acp from "@agentclientprotocol/sdk";
import { useEffect, useRef, useState, type DragEvent } from "react";
import type { Attachment, ChangeHunk, ChangesMessage, QueuedInfo, TabGroupInfo, TabInfo, TerminalSnapshot, WorktreeDiff } from "../../chat/protocol";
import type { Totals } from "../../usageLedger";
import { Icon } from "../icon";
import { useL10n } from "../l10n";
import chevronDownIcon from "@tabler/icons/outline/chevron-down.svg";
import chevronRightIcon from "@tabler/icons/outline/chevron-right.svg";
import gitBranchIcon from "@tabler/icons/outline/git-branch.svg";
import pinIcon from "@tabler/icons/outline/pin.svg";
import pinFilledIcon from "@tabler/icons/filled/pin.svg";
import plusIcon from "@tabler/icons/outline/plus.svg";
import xIcon from "@tabler/icons/outline/x.svg";
import { post } from "./post";
import type { Usage } from "./usageMeter";
import type { AgentChoices } from "./agentPanel";
import { dropIndex, memberTitle, openRequests, requestsLabel, sumChanges, tabChanges, tabRows, type TabChanges } from "./tabRows";
import { EMPTY, type Transcript } from "./transcript";

export interface Status {
  text: string;
  busy?: boolean;
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
}

export const NEW_TAB: TabState = {
  transcript: EMPTY,
  config: [],
  status: { text: "" },
  attachments: [],
  commands: [],
  terminals: {},
  queue: [],
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
      return { ...state, [action.tab]: { ...tab, transcript: from.transcript, commands: from.commands, config: from.config } };
    }
  }
}

/** Drag data type of a tab being reordered; the view's file drop ignores it. */
export const TAB_DRAG_TYPE = "application/x-code-acp-tab";

export const isTabDrag = (e: { dataTransfer: DataTransfer | null }) => e.dataTransfer?.types.includes(TAB_DRAG_TYPE) ?? false;

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

/** The tabs as a rail beside the conversation that opens over it on hover (CSS); `data-open` holds it open while a tab is dragged or renamed. */
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
}: {
  tabs: TabInfo[];
  groups: TabGroupInfo[];
  states: Record<number, TabState>;
  active: number | undefined;
  /** The group whose comparison is shown, instead of the active tab. */
  shownGroup: number | undefined;
  agents: AgentChoices["agents"];
  /** codeAcp.showChanges: counts the files awaiting review too. */
  showChanges: boolean;
  onSelect: (id: number) => void;
  onSelectGroup: (id: number) => void;
  /** The tab whose name is being edited; `onRename` starts or ends the edit. */
  renaming: number | undefined;
  onRename: (id: number | undefined) => void;
}) {
  const { t, lang } = useL10n();
  const dateFormat = new Intl.DateTimeFormat(lang, { dateStyle: "medium", timeStyle: "short" });
  const list = useRef<HTMLDivElement>(null);
  const [dragged, setDragged] = useState<Dragged>();
  const [dropLine, setDropLine] = useState<DropLine>();
  const [renamingGroup, setRenamingGroup] = useState<number>();
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
        if (dropLine?.key !== key || dropLine.after !== after) setDropLine({ key, after, at: first + (after ? ids.length : 0) });
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
    list.current?.querySelector("[data-active]")?.scrollIntoView({ block: "nearest" });
  }, [active, shownGroup, tabs.length]);

  const tabRow = (tab: TabInfo, member: boolean) => {
    const state = states[tab.id];
    const requests = requestsLabel(openRequests(state), t);
    const waiting = requests !== undefined;
    const changed = tabChanges(state, showChanges);
    const title = (member ? memberTitle(tab, agents) : tab.title) || t("chat.newTab");
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
    const key = `tab-${tab.id}`;
    return (
      <div
        key={key}
        className="tab"
        role="tab"
        draggable={tab.id !== renaming}
        aria-selected={tab.id === active && shownGroup === undefined}
        data-member={member || undefined}
        data-active={(tab.id === active && shownGroup === undefined) || undefined}
        data-busy={state?.status.busy || undefined}
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
        onClick={() => onSelect(tab.id)}
        onDoubleClick={() => onRename(tab.id)}
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
                if (name !== undefined && name !== (member ? title : (tab.title ?? ""))) post({ type: "renameTab", tab: tab.id, title: name });
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
            title={t("chat.closeTab")}
            aria-label={t("chat.closeTab")}
            onClick={(e) => {
              e.stopPropagation();
              post({ type: "closeTab", tab: tab.id });
            }}
          >
            <Icon svg={xIcon} />
          </button>
        )}
      </div>
    );
  };

  const groupRow = (group: TabGroupInfo, members: TabInfo[]) => {
    const running = members.filter((tab) => states[tab.id]?.status.busy || tab.attempt === "running").length;
    const open = members.map((tab) => openRequests(states[tab.id]));
    const requests = requestsLabel(
      { permissions: open.reduce((sum, each) => sum + each.permissions, 0), questions: open.reduce((sum, each) => sum + each.questions, 0) },
      t,
    );
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
          draggable={group.id !== renamingGroup}
          aria-selected={group.id === shownGroup}
          data-group
          data-active={group.id === shownGroup || undefined}
          // With the rail closed, the group's row stands for the active tab among its own.
          data-current={members.some((tab) => tab.id === active) || undefined}
          data-busy={running > 0 || undefined}
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
          onClick={() => onSelectGroup(group.id)}
          onDoubleClick={() => setRenamingGroup(group.id)}
          onAuxClick={(e) => {
            if (e.button === 1 && !pinned) post({ type: "closeGroup", group: group.id });
          }}
          {...dragProps(key, members.map((tab) => tab.id), group.id)}
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
                  if (name !== undefined && name !== group.title) post({ type: "renameGroup", group: group.id, title: name });
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
        {!group.collapsed && members.map((tab) => tabRow(tab, true))}
      </div>
    );
  };

  return (
    <div id="tabs" role="tablist" data-open={dragged !== undefined || renaming !== undefined || renamingGroup !== undefined || undefined}>
      <div id="tab-panel">
        <button id="new-tab" title={t("chat.newTab")} aria-label={t("chat.newTab")} onClick={() => post({ type: "newTab" })}>
          <span className="tab-marker" aria-hidden="true">
            <Icon svg={plusIcon} />
          </span>
          <span className="tab-title">{t("chat.newTab")}</span>
        </button>
        <div id="tab-list" ref={list}>
          {tabRows(tabs, groups).map((row) => (row.kind === "tab" ? tabRow(row.tab, false) : groupRow(row.group, row.members)))}
        </div>
      </div>
    </div>
  );
}

/** Edits a name in place: Enter or leaving the field keeps it, Escape drops it (`undefined`). */
function TabNameInput({ label, initial, onDone }: { label: string; initial: string; onDone: (name: string | undefined) => void }) {
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
