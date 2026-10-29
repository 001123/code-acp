import type * as acp from "@agentclientprotocol/sdk";
import { useEffect, useRef, useState } from "react";
import type { Attachment, ChangesMessage, TabInfo, TerminalSnapshot } from "../../chat/protocol";
import { Icon } from "../icon";
import { useL10n } from "../l10n";
import pinIcon from "@tabler/icons/outline/pin.svg";
import pinFilledIcon from "@tabler/icons/filled/pin.svg";
import plusIcon from "@tabler/icons/outline/plus.svg";
import xIcon from "@tabler/icons/outline/x.svg";
import { post } from "./post";
import type { Usage } from "./toolbar";
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
  usage?: Usage;
  /** Auto-compact window the host read from the agent's settings. */
  compactAt?: number;
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
}

export const NEW_TAB: TabState = { transcript: EMPTY, config: [], status: { text: "" }, attachments: [], commands: [], terminals: {} };

export type TabsAction =
  | { type: "update"; tab: number; f: (state: TabState) => TabState }
  /** Drops the state of tabs that were closed. */
  | { type: "keep"; ids: number[] };

export function tabStates(state: Record<number, TabState>, action: TabsAction): Record<number, TabState> {
  switch (action.type) {
    case "update":
      return { ...state, [action.tab]: action.f(state[action.tab] ?? NEW_TAB) };
    case "keep":
      return Object.fromEntries(action.ids.flatMap((id) => (state[id] ? [[id, state[id]]] : [])));
  }
}

/** Drag data type of a tab being reordered; the view's file drop ignores it. */
export const TAB_DRAG_TYPE = "application/x-code-acp-tab";

export const isTabDrag = (e: { dataTransfer: DataTransfer | null }) => e.dataTransfer?.types.includes(TAB_DRAG_TYPE) ?? false;

export function TabStrip({
  tabs,
  states,
  active,
  onSelect,
}: {
  tabs: TabInfo[];
  states: Record<number, TabState>;
  active: number | undefined;
  onSelect: (id: number) => void;
}) {
  const { t, lang } = useL10n();
  const dateFormat = new Intl.DateTimeFormat(lang, { dateStyle: "medium", timeStyle: "short" });
  const strip = useRef<HTMLDivElement>(null);
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
    strip.current?.querySelector("[data-active]")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active, tabs.length]);
  return (
    <div id="tabs" role="tablist">
      <div
        id="tab-list"
        ref={strip}
        // A vertical wheel scrolls the single row sideways.
        onWheel={(e) => {
          if (e.deltaX === 0) e.currentTarget.scrollLeft += e.deltaY;
        }}
      >
        {tabs.map((tab) => {
          const state = states[tab.id];
          const waiting = state?.transcript.items.some((i) => i.kind === "permission" && !i.done);
          const title = tab.title || t("chat.newTab");
          const tooltip = [
            waiting ? `${title} · ${t("chat.tabWaiting")}` : title,
            ...(tab.createdAt === undefined ? [] : [t("chat.tabCreated", dateFormat.format(tab.createdAt))]),
          ].join("\n");
          const pinLabel = t(tab.pinned ? "chat.unpinTab" : "chat.pinTab");
          return (
            <div
              key={tab.id}
              className="tab"
              role="tab"
              draggable
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
                preventDefaultContextMenuItems: true,
              })}
              onClick={() => onSelect(tab.id)}
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
                const after = e.clientX > box.left + box.width / 2;
                if (dropAt?.id !== tab.id || dropAt.after !== after) setDropAt({ id: tab.id, after });
              }}
              onDrop={(e) => {
                if (!isTabDrag(e)) return;
                e.preventDefault();
                if (dropAt) drop(dropAt);
                endDrag();
              }}
            >
              <span className="tab-dot" />
              <span className="tab-title">{title}</span>
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
      <button className="icon-btn" id="new-tab" title={t("chat.newTab")} aria-label={t("chat.newTab")} onClick={() => post({ type: "newTab" })}>
        <Icon svg={plusIcon} />
      </button>
    </div>
  );
}
