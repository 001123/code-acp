import type * as acp from "@agentclientprotocol/sdk";
import { useState } from "react";
import { Icon } from "../icon";
import { useL10n } from "../l10n";
import searchIcon from "@tabler/icons/outline/search.svg";
import xIcon from "@tabler/icons/outline/x.svg";
import { post } from "./post";
import { matchesSession } from "./search";

export interface History {
  sessions: acp.SessionInfo[];
  loading?: boolean;
  unsupported?: boolean;
  canOpen?: boolean;
  currentId?: string;
  /** Sessions shown in a tab. */
  openIds?: string[];
}

/** "5 minutes ago" style label for an ISO timestamp. */
function relativeTime(lang: string, iso: string | null | undefined): string {
  const time = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(time)) return "";
  const seconds = (time - Date.now()) / 1000;
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31536000],
    ["month", 2592000],
    ["week", 604800],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  const format = new Intl.RelativeTimeFormat(lang, { numeric: "auto" });
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
  }
  return format.format(0, "minute");
}

export function HistoryView({ history, onClose }: { history: History; onClose: () => void }) {
  const { t, lang } = useL10n();
  const [query, setQuery] = useState("");
  const sessions = history.sessions
    .filter((s) => matchesSession(s, query))
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  const message = history.loading
    ? t("chat.historyLoading")
    : history.unsupported
      ? t("chat.historyUnsupported")
      : history.sessions.length === 0
        ? t("chat.historyEmpty")
        : sessions.length === 0
          ? t("chat.historyNoMatch")
          : history.canOpen
            ? undefined
            : t("chat.historyCannotOpen");
  return (
    <div id="history">
      <div id="history-header">
        <span id="history-title">{t("chat.history")}</span>
        <button className="icon-btn" title={t("chat.close")} aria-label={t("chat.close")} onClick={onClose}>
          <Icon svg={xIcon} />
        </button>
      </div>
      {history.sessions.length > 0 && (
        <div id="history-search">
          <Icon svg={searchIcon} />
          <input
            type="search"
            autoFocus
            value={query}
            placeholder={t("chat.historySearch")}
            aria-label={t("chat.historySearch")}
            onChange={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                if (query) setQuery("");
                else onClose();
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
              onClick={(e) => {
                setQuery("");
                e.currentTarget.parentElement?.querySelector("input")?.focus();
              }}
            >
              <Icon svg={xIcon} />
            </button>
          )}
        </div>
      )}
      {message && <div className="history-message">{message}</div>}
      <ul
        id="history-list"
        // Arrow keys walk the list; Up from the first item returns to the search box.
        onKeyDown={(e) => {
          if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
          const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>(".history-item:not(:disabled)")];
          const i = items.indexOf(document.activeElement as HTMLButtonElement);
          if (i < 0) return;
          e.preventDefault();
          const next = items[i + (e.key === "ArrowDown" ? 1 : -1)];
          if (next) next.focus();
          else if (e.key === "ArrowUp") document.querySelector<HTMLInputElement>("#history-search input")?.focus();
        }}
      >
        {sessions.map((s) => (
          <li key={s.sessionId}>
            <button
              className="history-item"
              data-current={s.sessionId === history.currentId || undefined}
              data-open={history.openIds?.includes(s.sessionId) || undefined}
              disabled={!history.canOpen}
              title={s.title ?? s.sessionId}
              onClick={() => {
                post({ type: "openSession", sessionId: s.sessionId, cwd: s.cwd, title: s.title ?? undefined });
                onClose();
              }}
            >
              <span className="history-item-title">{s.title?.trim() || t("chat.untitled")}</span>
              {s.sessionId === history.currentId ? (
                <span className="history-item-badge" data-current>
                  {t("chat.currentSession")}
                </span>
              ) : (
                history.openIds?.includes(s.sessionId) && <span className="history-item-badge">{t("chat.openInTab")}</span>
              )}
              <span className="history-item-meta">{relativeTime(lang, s.updatedAt)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
