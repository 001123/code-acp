import type * as acp from "@agentclientprotocol/sdk";
import { Icon } from "../icon";
import { useL10n } from "../l10n";
import xIcon from "@tabler/icons/outline/x.svg";
import { post } from "./post";

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
  const sessions = [...history.sessions].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  const message = history.loading
    ? t("chat.historyLoading")
    : history.unsupported
      ? t("chat.historyUnsupported")
      : sessions.length === 0
        ? t("chat.historyEmpty")
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
      {message && <div className="history-message">{message}</div>}
      <ul id="history-list">
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
              <span className="history-item-meta">
                {s.sessionId === history.currentId
                  ? t("chat.currentSession")
                  : history.openIds?.includes(s.sessionId)
                    ? t("chat.openInTab")
                    : relativeTime(lang, s.updatedAt)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
