import { useEffect, useRef, useState, type ReactNode } from "react";
import chartIcon from "@tabler/icons/outline/chart-bar.svg";
import chevronIcon from "@tabler/icons/outline/chevron-right.svg";
import infoIcon from "@tabler/icons/outline/info-circle.svg";
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
          // Cents once there are whole units; small amounts keep enough digits to show.
          minimumFractionDigits: 2,
          maximumFractionDigits: amount >= 1 ? 2 : 4,
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
  /** The year only when it isn't this one. */
  const time = (ms: number) =>
    new Intl.DateTimeFormat(lang, {
      day: "numeric",
      month: "short",
      year: new Date(ms).getFullYear() === new Date().getFullYear() ? undefined : "numeric",
      hour: "numeric",
      minute: "2-digit",
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

/** The token column shared by the tables: the total; a row's details break it down. */
function TokenCells({ tokens: n }: { tokens: Tokens }) {
  const { t, exact, tokens } = useFormat();
  return (
    <td className="num" title={tokenTitle(t, exact, n)}>
      {tokens(n.total)}
    </td>
  );
}

function TokenHeads() {
  const { t } = useL10n();
  return <th className="num">{t("usage.tokens")}</th>;
}

type Detail = readonly [label: string, value: ReactNode];

/** What the tokens are made of, as row details; kinds the agent never reported are left out. */
function useTokenDetails(): (tokens: Tokens) => Detail[] {
  const { t, exact } = useFormat();
  return (n) =>
    (
      [
        [t("usage.input"), n.input],
        [t("usage.output"), n.output],
        [t("usage.cachedRead"), n.cachedRead],
        [t("usage.cachedWrite"), n.cachedWrite],
        [t("usage.thought"), n.thought],
      ] as const
    )
      .filter(([, v]) => v > 0)
      .map(([label, v]) => [label, exact.format(v)] as const);
}

/** A table row that opens to show its details beneath, so the table itself keeps only the headline figures. */
function Row({ cells, details }: { cells: ReactNode; details: ReadonlyArray<Detail> }) {
  const [open, setOpen] = useState(false);
  if (!details.length) {
    return (
      <tr>
        <td className="usage-toggle" />
        {cells}
      </tr>
    );
  }
  const toggle = () => setOpen(!open);
  return (
    <>
      <tr
        className="usage-row"
        tabIndex={0}
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggle();
          }
        }}
      >
        <td className="usage-toggle">
          <Icon svg={chevronIcon} />
        </td>
        {cells}
      </tr>
      {open && (
        <tr className="usage-details-row">
          <td colSpan={99}>
            <dl className="usage-details">
              {details.map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * A table that scrolls sideways when it is wider than the page. The mouse wheel scrolls it too, not only Shift+wheel
 * or a trackpad; at either end the wheel scrolls the page again.
 */
function TableScroll({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
      const max = el.scrollWidth - el.clientWidth;
      if (max <= 0) return;
      const delta = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? e.deltaY * 16 : e.deltaY;
      if ((delta < 0 && el.scrollLeft <= 0) || (delta > 0 && el.scrollLeft >= max - 1)) return;
      e.preventDefault();
      el.scrollLeft += delta;
    };
    // Not passive, so the page doesn't scroll as well.
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);
  return (
    <div ref={ref} className="card usage-table">
      {children}
    </div>
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
  const tokenDetails = useTokenDetails();
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
      <TableScroll>
        <table>
          <thead>
            <tr>
              <th className="usage-toggle" />
              <th>{t(grouping === "day" ? "usage.day" : "usage.month1")}</th>
              <th className="num">{t("usage.turns")}</th>
              <TokenHeads />
              <th className="num">{t("usage.cost")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, shown).map((r) => (
              <Row
                key={r.key}
                details={tokenDetails(r.tokens)}
                cells={
                  <>
                    <td className="nowrap" title={r.key}>
                      {r.label}
                    </td>
                    <td className="num">{exact.format(r.turns)}</td>
                    <TokenCells tokens={r.tokens} />
                    <td className="num">{cost(r.cost)}</td>
                  </>
                }
              />
            ))}
          </tbody>
        </table>
      </TableScroll>
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
  const tokenDetails = useTokenDetails();
  return (
    <section className="usage-section">
      <h3>{t("usage.byAgent")}</h3>
      <TableScroll>
        <table>
          <thead>
            <tr>
              <th className="usage-toggle" />
              <th>{t("usage.agent")}</th>
              <th className="num">{t("usage.sessions")}</th>
              <th className="num">{t("usage.turns")}</th>
              <TokenHeads />
              <th className="num">{t("usage.cost")}</th>
            </tr>
          </thead>
          <tbody>
            {usage.agents.map((a) => (
              <Row
                key={a.agentId}
                details={tokenDetails(a.tokens)}
                cells={
                  <>
                    <td className="nowrap">{a.agentName}</td>
                    <td className="num">{exact.format(a.sessions)}</td>
                    <td className="num">{exact.format(a.turns)}</td>
                    <TokenCells tokens={a.tokens} />
                    <td className="num">{cost(a.cost)}</td>
                  </>
                }
              />
            ))}
          </tbody>
        </table>
      </TableScroll>
    </section>
  );
}

function Sessions({ usage, onQuery }: { usage: UsageView; onQuery: (text: string, limit: number) => void }) {
  const { t, exact, cost, time } = useFormat();
  const tokenDetails = useTokenDetails();
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
        <TableScroll>
          <table>
            <thead>
              <tr>
                <th className="usage-toggle" />
                <th>{t("usage.session")}</th>
                <th className="num">{t("usage.turns")}</th>
                <TokenHeads />
                <th className="num">{t("usage.cost")}</th>
              </tr>
            </thead>
            <tbody>
              {usage.sessions.map((s) => (
                <Row
                  key={`${s.agentId} ${s.sessionId}`}
                  details={[
                    [t("usage.agent"), s.agentName],
                    [t("usage.folder"), <span title={s.cwd}>{s.cwd}</span>],
                    [t("usage.firstUsed"), time(s.firstAt)],
                    [t("usage.lastUsed"), time(s.lastAt)],
                    ...tokenDetails(s.tokens),
                  ]}
                  cells={
                    <>
                      <td className="usage-session" title={s.title ?? s.sessionId}>
                        <span className="usage-session-title">{s.title || t("chat.untitled")}</span>
                        <span className="desc">{`${s.folder} · ${time(s.lastAt)}`}</span>
                      </td>
                      <td className="num">{exact.format(s.turns)}</td>
                      <TokenCells tokens={s.tokens} />
                      <td className="num">{cost(s.cost)}</td>
                    </>
                  }
                />
              ))}
            </tbody>
          </table>
        </TableScroll>
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
        <p className="usage-note">
          <Icon svg={infoIcon} />
          <span>{t("usage.note")}</span>
        </p>
        <button className="secondary with-icon" disabled={empty} onClick={onClear}>
          <Icon svg={trashIcon} />
          {t("usage.clear")}
        </button>
      </div>
    </div>
  );
}
