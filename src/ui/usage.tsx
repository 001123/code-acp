import { useEffect, useState } from "react";
import chartIcon from "@tabler/icons/outline/chart-bar.svg";
import searchIcon from "@tabler/icons/outline/search.svg";
import trashIcon from "@tabler/icons/outline/trash.svg";
import type { UsageView } from "../settingsPanel";
import type { Costs, Tokens, Totals } from "../usageLedger";
import { Icon } from "./icon";
import { useL10n, type Translate } from "./l10n";

function useFormat() {
  const { t, lang } = useL10n();
  const exact = new Intl.NumberFormat(lang);
  const compact = new Intl.NumberFormat(lang, {
    notation: "compact",
    maximumFractionDigits: 1,
  });
  /** Each currency on its own, e.g. "$1.20 + €0.40"; a dash when nothing was spent. */
  const cost = (costs: Costs) => {
    const parts = Object.entries(costs)
      .filter(([, amount]) => amount > 0)
      .map(([currency, amount]) =>
        new Intl.NumberFormat(lang, {
          style: "currency",
          currency,
          maximumFractionDigits: 4,
        }).format(amount),
      );
    return parts.length ? parts.join(" + ") : "—";
  };
  const tokens = (n: number) => (n ? compact.format(n) : "—");
  const date = (day: string) =>
    new Intl.DateTimeFormat(lang, {
      weekday: "short",
      day: "numeric",
      month: "short",
    }).format(new Date(`${day}T00:00`));
  const month = (key: string) =>
    new Intl.DateTimeFormat(lang, { month: "long", year: "numeric" }).format(new Date(`${key}-01T00:00`));
  const time = (ms: number) =>
    new Intl.DateTimeFormat(lang, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(ms);
  return { t, exact, cost, tokens, date, month, time };
}

/** The exact counts behind a compact token figure. */
function tokenTitle(t: Translate, exact: Intl.NumberFormat, tokens: Tokens): string {
  return [
    [t("usage.input"), tokens.input],
    [t("usage.output"), tokens.output],
    [t("usage.cachedRead"), tokens.cachedRead],
    [t("usage.cachedWrite"), tokens.cachedWrite],
    [t("usage.thought"), tokens.thought],
    [t("usage.total"), tokens.total],
  ]
    .filter(([, n]) => n)
    .map(([label, n]) => `${label}: ${exact.format(n as number)}`)
    .join("\n");
}

function Tile({ label, totals }: { label: string; totals: Totals }) {
  const { t, exact, cost, tokens } = useFormat();
  return (
    <div className="usage-tile">
      <div className="desc">{label}</div>
      <div className="usage-tile-value">{cost(totals.cost)}</div>
      <div className="desc" title={tokenTitle(t, exact, totals.tokens)}>
        {t("usage.tileDetail", tokens(totals.tokens.total), exact.format(totals.turns))}
      </div>
    </div>
  );
}

/** Token columns shared by both tables. */
function TokenCells({ tokens: n }: { tokens: Tokens }) {
  const { t, exact, tokens } = useFormat();
  const title = tokenTitle(t, exact, n);
  return (
    <>
      <td className="num" title={title}>
        {tokens(n.input)}
      </td>
      <td className="num" title={title}>
        {tokens(n.output)}
      </td>
      <td className="num" title={title}>
        {tokens(n.cachedRead + n.cachedWrite)}
      </td>
      <td className="num" title={title}>
        {tokens(n.total)}
      </td>
    </>
  );
}

function TokenHeads() {
  const { t } = useL10n();
  return (
    <>
      <th className="num">{t("usage.input")}</th>
      <th className="num">{t("usage.output")}</th>
      <th className="num">{t("usage.cache")}</th>
      <th className="num">{t("usage.total")}</th>
    </>
  );
}

/** Rows of the day table shown at first, and added with each "show more". */
const DAY_PAGE = 31;

function addTotals(a: Totals, b: Totals): Totals {
  const cost: Record<string, number> = { ...a.cost };
  for (const [currency, amount] of Object.entries(b.cost)) cost[currency] = (cost[currency] ?? 0) + amount;
  const tokens = { ...a.tokens };
  for (const key of Object.keys(tokens) as Array<keyof Tokens>) tokens[key] += b.tokens[key];
  return { turns: a.turns + b.turns, tokens, cost };
}

/** The days summed by `YYYY-MM`, newest first (the days come newest first). */
function byMonth(days: UsageView["days"]): Array<Totals & { key: string }> {
  const months: Array<Totals & { key: string }> = [];
  for (const d of days) {
    const key = d.day.slice(0, 7);
    const last = months.at(-1);
    if (last?.key === key) months[months.length - 1] = { key, ...addTotals(last, d) };
    else months.push({ key, turns: d.turns, tokens: d.tokens, cost: d.cost });
  }
  return months;
}

function Periods({ usage }: { usage: UsageView }) {
  const { t, exact, cost, date, month } = useFormat();
  const [grouping, setGrouping] = useState<"day" | "month">("day");
  const [shown, setShown] = useState(DAY_PAGE);
  const rows =
    grouping === "day"
      ? usage.days.map((d) => ({ key: d.day, label: date(d.day), ...d }))
      : byMonth(usage.days).map((m) => ({ ...m, label: month(m.key) }));
  return (
    <section className="usage-section">
      <div className="usage-section-head">
        <h3>{t(grouping === "day" ? "usage.byDay" : "usage.byMonth")}</h3>
        <div className="segmented" role="radiogroup">
          {(["day", "month"] as const).map((g) => (
            <button
              key={g}
              type="button"
              role="radio"
              aria-checked={grouping === g}
              onClick={() => {
                setGrouping(g);
                setShown(DAY_PAGE);
              }}
            >
              {t(g === "day" ? "usage.days" : "usage.months")}
            </button>
          ))}
        </div>
      </div>
      <div className="card usage-table">
        <table>
          <thead>
            <tr>
              <th>{t(grouping === "day" ? "usage.day" : "usage.month1")}</th>
              <th className="num">{t("usage.turns")}</th>
              <TokenHeads />
              <th className="num">{t("usage.cost")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, shown).map((r) => (
              <tr key={r.key}>
                <td className="nowrap" title={r.key}>
                  {r.label}
                </td>
                <td className="num">{exact.format(r.turns)}</td>
                <TokenCells tokens={r.tokens} />
                <td className="num">{cost(r.cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > shown && <ShowMore shown={shown} total={rows.length} onClick={() => setShown(shown + DAY_PAGE)} />}
    </section>
  );
}

function ShowMore({ shown, total, onClick }: { shown: number; total: number; onClick: () => void }) {
  const { t, exact } = useFormat();
  return (
    <div className="usage-more">
      <span className="desc">{t("usage.showing", exact.format(Math.min(shown, total)), exact.format(total))}</span>
      <button className="secondary" onClick={onClick}>
        {t("usage.showMore")}
      </button>
    </div>
  );
}

function Agents({ usage }: { usage: UsageView }) {
  const { t, exact, cost } = useFormat();
  return (
    <section className="usage-section">
      <h3>{t("usage.byAgent")}</h3>
      <div className="card usage-table">
        <table>
          <thead>
            <tr>
              <th>{t("usage.agent")}</th>
              <th className="num">{t("usage.sessions")}</th>
              <th className="num">{t("usage.turns")}</th>
              <TokenHeads />
              <th className="num">{t("usage.cost")}</th>
            </tr>
          </thead>
          <tbody>
            {usage.agents.map((a) => (
              <tr key={a.agentId}>
                <td>{a.agentName}</td>
                <td className="num">{exact.format(a.sessions)}</td>
                <td className="num">{exact.format(a.turns)}</td>
                <TokenCells tokens={a.tokens} />
                <td className="num">{cost(a.cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Sessions({ usage, onQuery }: { usage: UsageView; onQuery: (text: string, limit: number) => void }) {
  const { t, exact, cost, time } = useFormat();
  const [text, setText] = useState(usage.query.text);
  // Asks again once typing pauses; a new search starts from the first page.
  useEffect(() => {
    if (text === usage.query.text) return;
    const timer = setTimeout(() => onQuery(text, usage.pageSize), 200);
    return () => clearTimeout(timer);
  }, [text]);
  return (
    <section className="usage-section">
      <div className="usage-section-head">
        <h3>{t("usage.bySession")}</h3>
        <label className="usage-search">
          <Icon svg={searchIcon} />
          <input
            type="search"
            value={text}
            placeholder={t("usage.search")}
            aria-label={t("usage.search")}
            onChange={(e) => setText(e.currentTarget.value)}
          />
        </label>
      </div>
      {usage.sessionCount === 0 ? (
        <div className="desc usage-none">{t("usage.noMatch")}</div>
      ) : (
        <div className="card usage-table">
          <table>
            <thead>
              <tr>
                <th>{t("usage.session")}</th>
                <th>{t("usage.agent")}</th>
                <th>{t("usage.lastUsed")}</th>
                <th className="num">{t("usage.turns")}</th>
                <TokenHeads />
                <th className="num">{t("usage.cost")}</th>
              </tr>
            </thead>
            <tbody>
              {usage.sessions.map((s) => (
                <tr key={`${s.agentId} ${s.sessionId}`}>
                  <td className="usage-session" title={`${s.title ?? s.sessionId}\n${s.cwd}`}>
                    <span className="usage-session-title">{s.title || t("chat.untitled")}</span>
                    <span className="desc">{s.folder}</span>
                  </td>
                  <td>{s.agentName}</td>
                  <td className="nowrap">{time(s.lastAt)}</td>
                  <td className="num">{exact.format(s.turns)}</td>
                  <TokenCells tokens={s.tokens} />
                  <td className="num">{cost(s.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {usage.sessionCount > usage.sessions.length && (
        <ShowMore
          shown={usage.sessions.length}
          total={usage.sessionCount}
          onClick={() => onQuery(usage.query.text, usage.query.limit + usage.pageSize)}
        />
      )}
    </section>
  );
}

/** The Usage tab of the settings page: totals for today, 7 and 30 days and all time, then by period, agent and session. */
export function UsageTab({
  usage,
  onClear,
  onQuery,
}: {
  usage: UsageView | undefined;
  onClear: () => void;
  onQuery: (text: string, limit: number) => void;
}) {
  const { t } = useL10n();
  if (!usage) return null;
  const empty = !usage.days.length && !usage.agents.length;
  return (
    <div className="usage">
      <div className="usage-tiles">
        <Tile label={t("usage.today")} totals={usage.today} />
        <Tile label={t("usage.week")} totals={usage.week} />
        <Tile label={t("usage.month")} totals={usage.month} />
        <Tile label={t("usage.all")} totals={usage.all} />
      </div>
      {empty ? (
        <div className="usage-empty">
          <Icon svg={chartIcon} />
          {t("usage.empty")}
        </div>
      ) : (
        <>
          <Periods usage={usage} />
          <Agents usage={usage} />
          <Sessions usage={usage} onQuery={onQuery} />
        </>
      )}
      <div className="usage-footer">
        <span className="desc">{t("usage.note")}</span>
        <button className="secondary with-icon" disabled={empty} onClick={onClear}>
          <Icon svg={trashIcon} />
          {t("usage.clear")}
        </button>
      </div>
    </div>
  );
}
