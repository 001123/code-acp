import { useEffect, useState } from "react";
import chartIcon from "@tabler/icons/outline/chart-bar.svg";
import clockIcon from "@tabler/icons/outline/clock-hour-4.svg";
import infoIcon from "@tabler/icons/outline/info-circle.svg";
import refreshIcon from "@tabler/icons/outline/refresh.svg";
import searchIcon from "@tabler/icons/outline/search.svg";
import type { CcusageSource, CcusageTotals, CcusageView } from "../ccusage";
import { Icon } from "./icon";
import { useL10n } from "./l10n";
import {
  DAY_PAGE,
  Row,
  ShowMore,
  TableScroll,
  TokenCells,
  TokenHeads,
  useFormat,
  useTokenDetails,
  type Detail,
} from "./usage";
import { getState, setState, useMessages } from "./vscode";

/** The agents ccusage reads, in the order offered after "all agents"; names are the products' own. */
const AGENTS: ReadonlyArray<readonly [Exclude<CcusageSource, "all">, string]> = [
  ["claude", "Claude Code"],
  ["codex", "Codex"],
  ["opencode", "OpenCode"],
  ["gemini", "Gemini CLI"],
  ["copilot", "GitHub Copilot CLI"],
  ["amp", "Amp"],
  ["droid", "Droid"],
  ["codebuff", "Codebuff"],
  ["hermes", "Hermes"],
  ["pi", "pi"],
  ["goose", "Goose"],
  ["kilo", "Kilo"],
  ["antigravity", "Antigravity"],
  ["kimi", "Kimi"],
  ["qwen", "Qwen"],
  ["openclaw", "OpenClaw"],
  ["grok", "Grok Build"],
  ["zcode", "ZCode"],
];

/** A "ccusage" message: the report of `source`, or why there is none. */
type Answer = { source: string; view?: CcusageView; error?: string };

/** Sessions listed at first, and added with each "show more". */
const SESSION_PAGE = 50;

const agentName = (id: string) => AGENTS.find(([agent]) => agent === id)?.[1] ?? id;

function savedSource(): CcusageSource {
  const saved = (getState() as { ccusageSource?: unknown } | undefined)?.ccusageSource;
  return AGENTS.find(([id]) => id === saved)?.[0] ?? "all";
}

/** Amounts in USD, as the cost formatter of the Usage tab takes them. */
const usd = (amount: number | undefined): Record<string, number> => (amount === undefined ? {} : { USD: amount });

/** The ccusage view of the Usage tab: one agent's local logs, asked for when shown and kept until refreshed. */
export function CcusageUsage({ onLoad }: { onLoad: (source: string, refresh: boolean) => void }) {
  const { t } = useL10n();
  const [source, setSource] = useState(savedSource);
  const [answers, setAnswers] = useState<Partial<Record<string, Answer>>>({});
  const [loading, setLoading] = useState<ReadonlySet<string>>(new Set());

  useMessages((msg) => {
    if (msg.type !== "ccusage") return;
    setAnswers((a) => ({ ...a, [msg.source]: msg as Answer }));
    setLoading((l) => new Set([...l].filter((s) => s !== msg.source)));
  });
  const load = (s: CcusageSource, refresh: boolean) => {
    setLoading((l) => new Set(l).add(s));
    onLoad(s, refresh);
  };
  useEffect(() => {
    if (!answers[source] && !loading.has(source)) load(source, false);
  }, [source]);

  const answer = answers[source];
  const busy = loading.has(source);
  return (
    <>
      <div className="usage-toolbar">
        <select
          aria-label={t("ccusage.agent")}
          value={source}
          onChange={(e) => {
            const next = e.target.value as CcusageSource;
            setSource(next);
            setState({ ...(getState() as object | undefined), ccusageSource: next });
          }}
        >
          <option value="all">{t("ccusage.allAgents")}</option>
          {AGENTS.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
        <button className="secondary with-icon" disabled={busy} onClick={() => load(source, true)}>
          <Icon svg={refreshIcon} />
          {t("ccusage.refresh")}
        </button>
      </div>
      {busy && !answer?.view ? (
        <div className="usage-empty">
          <span className="spinner" />
          {t("ccusage.loading")}
        </div>
      ) : answer?.error ? (
        <div className="usage-empty usage-error">
          <span>{answer.error}</span>
          {source === "all" && <span className="desc">{t("ccusage.allFailedHint")}</span>}
        </div>
      ) : (
        answer?.view && <Report view={answer.view} />
      )}
      <div className="usage-footer">
        <p className="usage-note">
          <Icon svg={infoIcon} />
          <span>{t("ccusage.note")}</span>
        </p>
      </div>
    </>
  );
}

function Tile({ label, totals }: { label: string; totals: CcusageTotals }) {
  const { t, cost, tokens } = useFormat();
  return (
    <div className="usage-tile">
      <div className="desc">{label}</div>
      <div className="usage-tile-value">{cost(usd(totals.cost))}</div>
      <div className="desc">{t("ccusage.tileDetail", tokens(totals.tokens.total))}</div>
    </div>
  );
}

function Report({ view }: { view: CcusageView }) {
  const { t } = useL10n();
  return (
    <>
      <div className="usage-tiles">
        <Tile label={t("usage.today")} totals={view.today} />
        <Tile label={t("usage.week")} totals={view.week} />
        <Tile label={t("usage.month")} totals={view.month} />
        <Tile label={t("usage.all")} totals={view.all} />
      </div>
      {view.block && <Block block={view.block} />}
      {view.days.length === 0 ? (
        <div className="usage-empty">
          <Icon svg={chartIcon} />
          {t("ccusage.empty")}
        </div>
      ) : (
        <>
          <Periods view={view} />
          {view.agents && <Agents agents={view.agents} />}
          <Models view={view} />
          <Sessions view={view} />
        </>
      )}
    </>
  );
}

/** The 5-hour billing block running now. */
function Block({ block }: { block: NonNullable<CcusageView["block"]> }) {
  const { t, cost, tokens, time } = useFormat();
  const left = Math.max(0, Math.round((block.end - Date.now()) / 60_000));
  const details: Detail[] = [
    [t("ccusage.blockCost"), cost(usd(block.cost))],
    [t("usage.tokens"), tokens(block.tokens)],
    [t("ccusage.blockEnds"), `${time(block.end)} · ${t("ccusage.minutesLeft", Math.floor(left / 60), left % 60)}`],
  ];
  if (block.costPerHour !== undefined) details.push([t("ccusage.burnRate"), t("ccusage.perHour", cost(usd(block.costPerHour)))]);
  if (block.projectedCost !== undefined) details.push([t("ccusage.projected"), cost(usd(block.projectedCost))]);
  return (
    <section className="usage-section">
      <h3 className="with-icon">
        <Icon svg={clockIcon} />
        {t("ccusage.block")}
      </h3>
      <div className="card usage-block">
        <dl className="usage-details">
          {details.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        <div className="desc">{block.models.join(", ")}</div>
      </div>
    </section>
  );
}

type DayRow = CcusageView["days"][number];

/** The days summed by `YYYY-MM`, newest first (the days come newest first). */
function byMonth(days: ReadonlyArray<DayRow>): Array<DayRow & { key: string }> {
  const months: Array<DayRow & { key: string }> = [];
  for (const d of days) {
    const key = d.day.slice(0, 7);
    const last = months.at(-1);
    if (last?.key === key) {
      const tokens = { ...last.tokens };
      for (const k of Object.keys(tokens) as Array<keyof typeof tokens>) tokens[k] += d.tokens[k];
      months[months.length - 1] = { ...last, tokens, cost: last.cost + d.cost, models: [...last.models, ...d.models] };
    } else {
      months.push({ ...d, key });
    }
  }
  return months;
}

/** A row's details: its tokens by kind, then its cost by model. */
function useDetails(): (row: DayRow) => Detail[] {
  const { cost } = useFormat();
  const tokenDetails = useTokenDetails();
  return (row) => {
    const byModel = new Map<string, number | undefined>();
    for (const m of row.models) {
      const before = byModel.get(m.name);
      byModel.set(m.name, m.cost === undefined ? before : (before ?? 0) + m.cost);
    }
    return [
      ...tokenDetails(row.tokens),
      ...[...byModel].map(([name, amount]) => [name, cost(usd(amount))] as const),
    ];
  };
}

function Periods({ view }: { view: CcusageView }) {
  const { t, cost, date, month } = useFormat();
  const details = useDetails();
  const [grouping, setGrouping] = useState<"day" | "month">("day");
  const [shown, setShown] = useState(DAY_PAGE);
  const rows =
    grouping === "day"
      ? view.days.map((d) => ({ ...d, key: d.day, label: date(d.day) }))
      : byMonth(view.days).map((m) => ({ ...m, label: month(m.key) }));
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
              <th>{t("ccusage.models")}</th>
              <TokenHeads />
              <th className="num">{t("usage.cost")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, shown).map((r) => (
              <Row
                key={r.key}
                details={details(r)}
                cells={
                  <>
                    <td className="nowrap" title={r.key}>
                      {r.label}
                    </td>
                    <td className="usage-models">{[...new Set(r.models.map((m) => m.name))].join(", ")}</td>
                    <TokenCells tokens={r.tokens} />
                    <td className="num">{cost(usd(r.cost))}</td>
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

function Agents({ agents }: { agents: NonNullable<CcusageView["agents"]> }) {
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
              <th className="num">{t("ccusage.sessions")}</th>
              <TokenHeads />
              <th className="num">{t("usage.cost")}</th>
            </tr>
          </thead>
          <tbody>
            {agents.map((a) => (
              <Row
                key={a.agent}
                details={tokenDetails(a.tokens)}
                cells={
                  <>
                    <td className="nowrap">{agentName(a.agent)}</td>
                    <td className="num">{exact.format(a.sessions)}</td>
                    <TokenCells tokens={a.tokens} />
                    <td className="num">{cost(usd(a.cost))}</td>
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

function Models({ view }: { view: CcusageView }) {
  const { t, cost } = useFormat();
  const tokenDetails = useTokenDetails();
  return (
    <section className="usage-section">
      <h3>{t("ccusage.byModel")}</h3>
      <TableScroll>
        <table>
          <thead>
            <tr>
              <th className="usage-toggle" />
              <th>{t("ccusage.model")}</th>
              <TokenHeads />
              <th className="num">{t("usage.cost")}</th>
            </tr>
          </thead>
          <tbody>
            {view.models.map((m) => (
              <Row
                key={m.name}
                details={tokenDetails(m.tokens)}
                cells={
                  <>
                    <td className="nowrap">{m.name}</td>
                    <TokenCells tokens={m.tokens} />
                    <td className="num">{cost(usd(m.cost))}</td>
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

function Sessions({ view }: { view: CcusageView }) {
  const { t, cost, time } = useFormat();
  const tokenDetails = useTokenDetails();
  const [text, setText] = useState("");
  const [shown, setShown] = useState(SESSION_PAGE);
  const query = text.trim().toLowerCase();
  const matching = query
    ? view.sessions.filter((s) => `${s.id} ${s.agent ? `${s.agent} ${agentName(s.agent)}` : ""} ${s.project ?? ""} ${s.models.join(" ")}`.toLowerCase().includes(query))
    : view.sessions;
  return (
    <section className="usage-section">
      <div className="usage-section-head">
        <h3>{t("usage.bySession")}</h3>
        <label className="usage-search">
          <Icon svg={searchIcon} />
          <input
            type="search"
            value={text}
            placeholder={t("ccusage.search")}
            aria-label={t("ccusage.search")}
            onChange={(e) => {
              setText(e.currentTarget.value);
              setShown(SESSION_PAGE);
            }}
          />
        </label>
      </div>
      {matching.length === 0 ? (
        <div className="desc usage-none">{t("usage.noMatch")}</div>
      ) : (
        <TableScroll>
          <table>
            <thead>
              <tr>
                <th className="usage-toggle" />
                <th>{t("usage.session")}</th>
                <TokenHeads />
                <th className="num">{t("usage.cost")}</th>
              </tr>
            </thead>
            <tbody>
              {matching.slice(0, shown).map((s) => {
                const details: Detail[] = [[t("ccusage.sessionId"), <span title={s.id}>{s.id}</span>]];
                if (s.agent) details.push([t("usage.agent"), agentName(s.agent)]);
                if (s.project) details.push([t("ccusage.project"), <span title={s.project}>{s.project}</span>]);
                if (s.firstAt !== undefined) details.push([t("usage.firstUsed"), time(s.firstAt)]);
                if (s.lastAt !== undefined) details.push([t("usage.lastUsed"), time(s.lastAt)]);
                if (s.models.length) details.push([t("ccusage.models"), s.models.join(", ")]);
                return (
                  <Row
                    key={`${s.agent ?? ""} ${s.id}`}
                    details={[...details, ...tokenDetails(s.tokens)]}
                    cells={
                      <>
                        <td className="usage-session" title={s.id}>
                          <span className="usage-session-title">{s.project ?? s.id}</span>
                          <span className="desc">
                            {[s.agent && agentName(s.agent), s.lastAt === undefined ? undefined : time(s.lastAt), s.models.join(", ")]
                              .filter(Boolean)
                              .join(" · ")}
                          </span>
                        </td>
                        <TokenCells tokens={s.tokens} />
                        <td className="num">{cost(usd(s.cost))}</td>
                      </>
                    }
                  />
                );
              })}
            </tbody>
          </table>
        </TableScroll>
      )}
      {matching.length > shown && (
        <ShowMore shown={shown} total={matching.length} onClick={() => setShown(shown + SESSION_PAGE)} />
      )}
    </section>
  );
}
