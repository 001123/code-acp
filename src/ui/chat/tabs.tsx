import type * as acp from "@agentclientprotocol/sdk";
import { useEffect, useRef, useState } from "react";
import type { Attachment, ChangeHunk, ChangesMessage, QueuedInfo, TabInfo, TerminalSnapshot } from "../../chat/protocol";
import type { Totals } from "../../usageLedger";
import { Icon } from "../icon";
import { useL10n } from "../l10n";
import gitBranchIcon from "@tabler/icons/outline/git-branch.svg";
import pinIcon from "@tabler/icons/outline/pin.svg";
import pinFilledIcon from "@tabler/icons/filled/pin.svg";
import plusIcon from "@tabler/icons/outline/plus.svg";
import xIcon from "@tabler/icons/outline/x.svg";
import { post } from "./post";
import type { Usage } from "./usageMeter";
import { EMPTY, openRequest, type Transcript } from "./transcript";

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

/** The tabs as a rail beside the conversation that opens over it on hover (CSS); `data-open` holds it open while a tab is dragged or renamed. */
export function TabSidebar({
  tabs,
  states,
  active,
  onSelect,
  renaming,
  onRename,
}: {
  tabs: TabInfo[];
  states: Record<number, TabState>;
  active: number | undefined;
  onSelect: (id: number) => void;
  /** The tab whose name is being edited; `onRename` starts or ends the edit. */
  renaming: number | undefined;
  onRename: (id: number | undefined) => void;
}) {
  const { t, lang } = useL10n();
  const dateFormat = new Intl.DateTimeFormat(lang, { dateStyle: "medium", timeStyle: "short" });
  const list = useRef<HTMLDivElement>(null);
  const [dragged, setDragged] = useState<number>();
  const [dropAt, setDropAt] = useState<{ id: number; after: boolean }>();
  const endDrag = () => {
    setDragged(undefined);
    setDropAt(undefined);
  };
  const drop = (target: { id: number; after: boolean }) => {
    const from = tabs.findIndex((x) => x.id === dragged);
    const at = tabs.findIndex((x) => x.id === target.id);
    if (dragged === undefined || from < 0 || at < 0) return;
    let index = at + (target.after ? 1 : 0);
    if (from < index) index--;
    if (index !== from) post({ type: "moveTab", tab: dragged, index });
  };
  useEffect(() => {
    list.current?.querySelector("[data-active]")?.scrollIntoView({ block: "nearest" });
  }, [active, tabs.length]);
  return (
    <div id="tabs" role="tablist" data-open={dragged !== undefined || renaming !== undefined || undefined}>
      <div id="tab-panel">
        <button id="new-tab" title={t("chat.newTab")} aria-label={t("chat.newTab")} onClick={() => post({ type: "newTab" })}>
          <span className="tab-marker" aria-hidden="true">
            <Icon svg={plusIcon} />
          </span>
          <span className="tab-title">{t("chat.newTab")}</span>
        </button>
        <div id="tab-list" ref={list}>
          {tabs.map((tab) => {
            const state = states[tab.id];
            const waiting = state?.transcript.items.some((i) => openRequest(i) !== undefined);
            const title = tab.title || t("chat.newTab");
            const tooltip = [
              waiting ? `${title} · ${t("chat.tabWaiting")}` : title,
              ...(tab.createdAt === undefined ? [] : [t("chat.tabCreated", dateFormat.format(tab.createdAt))]),
              ...(tab.worktree ? [t("chat.tabWorktree", tab.worktree.branch ?? tab.worktree.root)] : []),
            ].join("\n");
            const meta = waiting
              ? t("chat.tabWaiting")
              : (tab.worktree?.branch ?? tab.worktree?.root ?? (tab.createdAt === undefined ? undefined : dateFormat.format(tab.createdAt)));
            const pinLabel = t(tab.pinned ? "chat.unpinTab" : "chat.pinTab");
            return (
              <div
                key={tab.id}
                className="tab"
                role="tab"
                draggable={tab.id !== renaming}
                aria-selected={tab.id === active}
                data-active={tab.id === active || undefined}
                data-busy={state?.status.busy || undefined}
                data-waiting={waiting || undefined}
                data-pinned={tab.pinned || undefined}
                data-dragging={tab.id === dragged || undefined}
                data-drop={dropAt?.id === tab.id ? (dropAt.after ? "after" : "before") : undefined}
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
                onDragStart={(e) => {
                  e.dataTransfer.setData(TAB_DRAG_TYPE, String(tab.id));
                  e.dataTransfer.effectAllowed = "move";
                  setDragged(tab.id);
                }}
                onDragEnd={endDrag}
                onDragOver={(e) => {
                  if (!isTabDrag(e)) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  const box = e.currentTarget.getBoundingClientRect();
                  const after = e.clientY > box.top + box.height / 2;
                  if (dropAt?.id !== tab.id || dropAt.after !== after) setDropAt({ id: tab.id, after });
                }}
                onDrop={(e) => {
                  if (!isTabDrag(e)) return;
                  e.preventDefault();
                  if (dropAt) drop(dropAt);
                  endDrag();
                }}
              >
                <span className="tab-marker" aria-hidden="true">
                  <span className="tab-initial">{tabInitial(title)}</span>
                  <span className="tab-dot" />
                </span>
                <span className="tab-text">
                  {tab.id === renaming ? (
                    <TabNameInput
                      // What the sidebar shows: the user's name, else the title. Clearing it drops the name.
                      initial={tab.title ?? ""}
                      onDone={(name) => {
                        onRename(undefined);
                        if (name !== undefined && name !== (tab.title ?? "")) post({ type: "renameTab", tab: tab.id, title: name });
                      }}
                    />
                  ) : (
                    <span className="tab-title">{title}</span>
                  )}
                  {meta !== undefined && (
                    <span className="tab-meta">
                      {tab.worktree && !waiting && <Icon svg={gitBranchIcon} />}
                      <span className="tab-meta-text">{meta}</span>
                    </span>
                  )}
                </span>
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
          })}
      </div>
      </div>
    </div>
  );
}

/** Edits a tab's name in place: Enter or leaving the field keeps it, Escape drops it (`undefined`). */
function TabNameInput({ initial, onDone }: { initial: string; onDone: (name: string | undefined) => void }) {
  const { t } = useL10n();
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
      aria-label={t("chat.renameTab")}
      placeholder={t("chat.renameTab")}
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
