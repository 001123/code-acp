import type * as acp from "@agentclientprotocol/sdk";
import { useState, type ReactNode, type RefObject } from "react";
import { Icon } from "../icon";
import { useL10n, type Translate } from "../l10n";
import sortIcon from "@tabler/icons/outline/arrows-sort.svg";
import checkIcon from "@tabler/icons/outline/check.svg";
import chevronDownIcon from "@tabler/icons/outline/chevron-down.svg";
import chevronRightIcon from "@tabler/icons/outline/chevron-right.svg";
import searchIcon from "@tabler/icons/outline/search.svg";
import trashIcon from "@tabler/icons/outline/trash.svg";
import xIcon from "@tabler/icons/outline/x.svg";
import { folderName, HISTORY_SORTS, relativeTime, shortTime, type HistoryGroup, type HistorySort } from "./historyList";
import { post } from "./post";

export interface History {
  sessions: acp.SessionInfo[];
  loading?: boolean;
  unsupported?: boolean;
  canOpen?: boolean;
  canDelete?: boolean;
  /** Why the list could not be read. */
  error?: string;
}

const SORT_LABELS = {
  updated: "chat.historySortUpdated",
  title: "chat.historySortTitle",
  folder: "chat.historySortFolder",
} as const;

/** A heading of the sidebar that collapses what is below it; its text starts past the rail, so the closed rail hides it. */
export function SidebarSection({
  label,
  detail,
  collapsed,
  onToggle,
  children,
}: {
  label: string;
  detail?: string;
  collapsed: boolean;
  onToggle: () => void;
  children?: ReactNode;
}) {
  const { t } = useL10n();
  return (
    <div className="tabs-section">
      <button
        className="tabs-section-toggle"
        title={t(collapsed ? "chat.sectionExpand" : "chat.sectionCollapse")}
        aria-expanded={!collapsed}
        onClick={onToggle}
      >
        <Icon svg={collapsed ? chevronRightIcon : chevronDownIcon} />
        <span className="tabs-section-label">{label}</span>
        {detail && <span className="tabs-section-detail">{detail}</span>}
      </button>
      {children}
    </div>
  );
}

/** The search box at the top of the sidebar: its icon stays in the closed rail. */
export function SidebarSearch({
  input,
  query,
  onQuery,
  onFocusChange,
  onLeave,
}: {
  input: RefObject<HTMLInputElement | null>;
  query: string;
  onQuery: (query: string) => void;
  onFocusChange: (focused: boolean) => void;
  /** Escape with nothing left to clear. */
  onLeave: () => void;
}) {
  const { t } = useL10n();
  return (
    <div id="tab-search">
      <button className="tab-marker" tabIndex={-1} aria-hidden="true" onClick={() => input.current?.focus()}>
        <Icon svg={searchIcon} />
      </button>
      <div id="tab-search-box">
        <input
          ref={input}
          type="search"
          value={query}
          placeholder={t("chat.historySearch")}
          aria-label={t("chat.historySearch")}
          onChange={(e) => onQuery(e.currentTarget.value)}
          onFocus={() => onFocusChange(true)}
          onBlur={() => onFocusChange(false)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              if (query) onQuery("");
              else onLeave();
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              document.querySelector<HTMLButtonElement>(".history-item:not(:disabled)")?.focus();
            }
          }}
        />
        {query && (
          <button
            className="icon-btn small"
            title={t("chat.historyClearSearch")}
            aria-label={t("chat.historyClearSearch")}
            onClick={() => {
              onQuery("");
              input.current?.focus();
            }}
          >
            <Icon svg={xIcon} />
          </button>
        )}
      </div>
    </div>
  );
}

/** The button and menu that pick the history's order. */
export function HistorySortMenu({
  menu,
  sort,
  onSort,
}: {
  menu: { open: boolean; toggle: () => void; set: (open: boolean) => void; root: RefObject<HTMLDivElement | null> };
  sort: HistorySort;
  onSort: (sort: HistorySort) => void;
}) {
  const { t } = useL10n();
  // Opens upwards when the heading sits low in the view.
  const [up, setUp] = useState(false);
  return (
    <div className="history-sort" ref={menu.root}>
      <button
        className="icon-btn small"
        // The tooltip would cover the menu.
        title={menu.open ? undefined : t("chat.historySort")}
        aria-label={t("chat.historySort")}
        aria-haspopup="menu"
        aria-expanded={menu.open}
        onClick={(e) => {
          setUp(window.innerHeight - e.currentTarget.getBoundingClientRect().bottom < 130);
          menu.toggle();
        }}
      >
        <Icon svg={sortIcon} />
      </button>
      {menu.open && (
        <div className="popup-menu history-sort-menu" role="menu" data-up={up || undefined}>
          {HISTORY_SORTS.map((each) => (
            <button
              key={each}
              role="menuitemradio"
              aria-checked={each === sort}
              onClick={() => {
                onSort(each);
                menu.set(false);
              }}
            >
              <span className="history-sort-check">{each === sort && <Icon svg={checkIcon} />}</span>
              {t(SORT_LABELS[each])}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** What stands in for the list, if anything. */
function historyMessage(t: Translate, history: History | undefined, listed: boolean): string | undefined {
  if (!history || (history.loading && history.sessions.length === 0)) return t("chat.historyLoading");
  if (history.error) return history.error;
  if (history.unsupported) return t("chat.historyUnsupported");
  if (history.sessions.length === 0) return t("chat.historyEmpty");
  if (!listed) return t("chat.historyAllOpen");
  return history.canOpen ? undefined : t("chat.historyCannotOpen");
}

/** The past conversations no tab shows. */
export function HistoryList({
  history,
  groups,
  searching,
  onOpened,
}: {
  history: History | undefined;
  groups: ReadonlyArray<HistoryGroup>;
  /** Only matches are shown: nothing to say about the rest. */
  searching: boolean;
  onOpened: () => void;
}) {
  const { t, lang } = useL10n();
  const message = searching ? undefined : historyMessage(t, history, groups.length > 0);
  return (
    <>
      {message && <div className="history-message">{message}</div>}
      <ul
        id="history-list"
        data-searching={searching || undefined}
        // Arrow keys walk the list; Up from the first item returns to the search box.
        onKeyDown={(e) => {
          if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
          const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>(".history-item:not(:disabled)")];
          const i = items.indexOf(document.activeElement as HTMLButtonElement);
          if (i < 0) return;
          e.preventDefault();
          const next = items[i + (e.key === "ArrowDown" ? 1 : -1)];
          if (next) next.focus();
          else if (e.key === "ArrowUp") document.querySelector<HTMLInputElement>("#tab-search input")?.focus();
        }}
      >
        {groups.flatMap(({ folder, sessions }) => [
          ...(folder === undefined
            ? []
            : [
                <li key={`folder-${folder}`} className="history-folder" title={folder}>
                  {folderName(folder)}
                </li>,
              ]),
          ...sessions.map((s) => {
            const title = s.title?.trim() || t("chat.untitled");
            return (
              <li key={s.sessionId} className="history-row">
                <button
                  className="history-item"
                  disabled={!history?.canOpen}
                  title={[title, relativeTime(lang, s.updatedAt), s.cwd].filter(Boolean).join("\n")}
                  onClick={() => {
                    post({ type: "openSession", sessionId: s.sessionId, cwd: s.cwd, title: s.title ?? undefined });
                    onOpened();
                  }}
                >
                  <span className="history-item-title">{title}</span>
                  <span className="history-item-meta">{shortTime(lang, s.updatedAt)}</span>
                </button>
                {history?.canDelete && (
                  <button
                    className="icon-btn small history-delete"
                    title={t("chat.deleteSession")}
                    aria-label={t("chat.deleteSession")}
                    onClick={() => post({ type: "deleteSession", sessionId: s.sessionId, title: s.title ?? undefined })}
                  >
                    <Icon svg={trashIcon} />
                  </button>
                )}
              </li>
            );
          }),
        ])}
      </ul>
    </>
  );
}
