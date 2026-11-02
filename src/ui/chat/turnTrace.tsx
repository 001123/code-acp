import type { TurnTrace } from "../../chat/protocol";
import { useL10n } from "../l10n";
import { post } from "./post";
import { formatDuration } from "./time";

/** The share of the turn's input that came from the cache; undefined when the agent doesn't report it. */
function cacheHit(tokens: TurnTrace["tokens"]): number | undefined {
  if (tokens?.cachedRead === undefined) return undefined;
  const input = tokens.input + tokens.cachedRead + (tokens.cachedWrite ?? 0);
  return input > 0 ? tokens.cachedRead / input : undefined;
}

/** The numbers of a finished turn: one line, which opens to all of them. */
export function TurnTraceView({ trace }: { trace: TurnTrace }) {
  const { t, lang } = useL10n();
  const { stopReason, durationMs, firstResponseMs, waiting, tools, subagents, changes, number, agent, sessionId, model, effort, tokens, context, cost } = trace;
  const compact = new Intl.NumberFormat(lang, { notation: "compact", maximumFractionDigits: 1 });
  const exact = new Intl.NumberFormat(lang);
  // A turn often costs less than a cent.
  const money = cost && new Intl.NumberFormat(lang, { style: "currency", currency: cost.currency, maximumFractionDigits: 4 });
  const count = (n: number | undefined) => (n === undefined ? undefined : exact.format(n));
  const percent = new Intl.NumberFormat(lang, { style: "percent", maximumFractionDigits: 1 });
  const seconds = new Intl.NumberFormat(lang, { maximumFractionDigits: 1 });
  const hit = cacheHit(tokens);
  const kinds = Object.entries(tools.kinds)
    .sort(([, a], [, b]) => b - a)
    .map(([kind, n]) => `${kind} ${exact.format(n)}`)
    .join(" · ");
  const toolCount = tools.failed > 0 ? t("chat.trace.toolsFailed", exact.format(tools.total), exact.format(tools.failed)) : exact.format(tools.total);
  const rows: Array<[string, string | undefined]> = [
    [t("chat.trace.stopReason"), stopReason],
    [t("chat.trace.duration"), formatDuration(durationMs)],
    [t("chat.trace.firstResponse"), firstResponseMs === undefined ? undefined : `${seconds.format(firstResponseMs / 1000)}s`],
    [t("chat.trace.waiting"), waiting.asks > 0 ? t("chat.trace.waitingValue", formatDuration(waiting.ms), exact.format(waiting.asks)) : undefined],
    [t("chat.trace.turn"), number === undefined ? undefined : `#${exact.format(number)}`],
    [t("chat.trace.tools"), kinds ? `${toolCount}: ${kinds}` : toolCount],
    [t("chat.trace.subagents"), subagents > 0 ? exact.format(subagents) : undefined],
    [t("chat.trace.files"), changes && t("chat.trace.filesValue", exact.format(changes.files), exact.format(changes.added), exact.format(changes.removed))],
    [t("chat.trace.agent"), agent],
    [t("chat.trace.model"), model],
    [t("chat.trace.effort"), effort],
    [t("usage.input"), count(tokens?.input)],
    [t("usage.output"), count(tokens?.output)],
    [t("usage.cachedRead"), count(tokens?.cachedRead)],
    [t("usage.cachedWrite"), count(tokens?.cachedWrite)],
    [t("usage.thought"), count(tokens?.thought)],
    [t("usage.total"), count(tokens?.total)],
    [t("chat.trace.cacheHit"), hit === undefined ? undefined : percent.format(hit)],
    [
      t("chat.contextWindow"),
      context && `${exact.format(context.used)} / ${exact.format(context.size)}${context.size > 0 ? ` (${percent.format(context.used / context.size)})` : ""}`,
    ],
    [t("chat.trace.turnCost"), cost && money?.format(cost.turn)],
    [t("chat.sessionCost"), cost && money?.format(cost.session)],
    [t("chat.trace.session"), sessionId],
  ];
  return (
    <details className="turn-trace">
      <summary>
        <span className="turn-trace-part turn-trace-optional">{formatDuration(durationMs)}</span>
        {cost && <span className="turn-trace-part turn-trace-key">{money?.format(cost.turn)}</span>}
        {tokens && <span className="turn-trace-part turn-trace-key">{t("chat.tokens", compact.format(tokens.total))}</span>}
        <span className="turn-trace-part turn-trace-optional">{stopReason}</span>
      </summary>
      <dl>
        {rows.map(([label, value]) =>
          value === undefined ? null : (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ),
        )}
      </dl>
      <a href="#" onClick={(e) => (e.preventDefault(), post({ type: "showTrace" }))}>
        {t("chat.trace.openLog")}
      </a>
    </details>
  );
}
