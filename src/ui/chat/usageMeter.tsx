import type * as acp from "@agentclientprotocol/sdk";
import type { Totals } from "../../usageLedger";
import { useL10n } from "../l10n";
import { post } from "./post";

export interface Usage {
  used: number;
  size: number;
  cost?: acp.Cost | null;
}

/** `compactAt`: where the agent auto-compacts, when that is before the end of the window. */
export function UsageMeter({
  usage,
  compactAt,
  totals,
}: {
  usage: Usage | undefined;
  compactAt: number | undefined;
  totals: Totals | undefined;
}) {
  const { t, lang } = useL10n();
  if (!usage) return <span id="usage" hidden />;
  const compact = new Intl.NumberFormat(lang, { notation: "compact", maximumFractionDigits: 1 });
  const exact = new Intl.NumberFormat(lang);
  const tokens = (n: number) => t("chat.tokens", exact.format(n));
  const limit = compactAt !== undefined && compactAt < usage.size ? compactAt : usage.size;
  const ratio = limit > 0 ? Math.min(1, usage.used / limit) : 0;
  const percent = Math.round(ratio * 100);
  const summary = t("chat.contextUsage", compact.format(usage.used), compact.format(limit), percent);
  const rows: Array<[string, string]> = [
    [t("chat.contextUsed"), tokens(usage.used)],
    [t("chat.contextLeft"), tokens(Math.max(0, limit - usage.used))],
    [t("chat.contextSize"), tokens(usage.size)],
  ];
  if (limit < usage.size) rows.push([t("chat.autoCompactAt"), tokens(limit)]);
  if (usage.cost) {
    const cost = new Intl.NumberFormat(lang, { style: "currency", currency: usage.cost.currency });
    rows.push([t("chat.sessionCost"), cost.format(usage.cost.amount)]);
  }
  if (totals?.tokens.total) rows.push([t("chat.sessionTokens"), tokens(totals.tokens.total)]);
  if (totals?.turns) rows.push([t("chat.sessionTurns"), exact.format(totals.turns)]);
  // A ring of radius 7 in a 16×16 box; the dash covers `ratio` of the circumference.
  const circumference = 2 * Math.PI * 7;
  return (
    // Focusable so the panel also opens from the keyboard.
    <span
      id="usage"
      tabIndex={0}
      role="button"
      aria-label={summary}
      onClick={() => post({ type: "showUsage" })}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") post({ type: "showUsage" });
      }}
      data-level={ratio >= 0.9 ? "high" : ratio >= 0.7 ? "medium" : "low"}>
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <circle className="usage-track" cx="8" cy="8" r="7" />
        <circle className="usage-fill" cx="8" cy="8" r="7" strokeDasharray={`${ratio * circumference} ${circumference}`} />
      </svg>
      <span id="usage-panel" role="tooltip">
        <span className="usage-head">
          <span>{t("chat.contextWindow")}</span>
          <span>{summary}</span>
        </span>
        <span className="usage-bar">
          <span style={{ width: `${percent}%` }} />
        </span>
        {rows.map(([label, value]) => (
          <span key={label} className="usage-row">
            <span>{label}</span>
            <span>{value}</span>
          </span>
        ))}
        <span className="usage-hint">{t("chat.showUsage")}</span>
      </span>
    </span>
  );
}
