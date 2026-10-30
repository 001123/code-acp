import { Context, DateTime, Duration, Effect, Layer, Schedule, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { t } from "./i18n";
import { readSettings } from "./settings";
import { NO_TOKENS, type Tokens } from "./usageLedger";

/** The ccusage release run through npx; pinned, so `npx -y` never pulls an unreviewed one. */
export const CCUSAGE_VERSION = "20.0.45";

/** What the Usage tab can show: every agent at once, or one of those ccusage reads, as its subcommands name them. */
export const CCUSAGE_SOURCES = [
  "all",
  "claude",
  "codex",
  "opencode",
  "amp",
  "droid",
  "codebuff",
  "hermes",
  "pi",
  "goose",
  "kilo",
  "copilot",
  "gemini",
  "antigravity",
  "kimi",
  "qwen",
  "openclaw",
  "grok",
  "zcode",
] as const;
export type CcusageSource = (typeof CCUSAGE_SOURCES)[number];
export const isCcusageSource = Schema.is(Schema.Literals(CCUSAGE_SOURCES));

/** Running ccusage failed, or it printed something other than its JSON report. */
export class CcusageError extends Schema.TaggedError<CcusageError>()("CcusageError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
  /** The run may succeed when tried again, e.g. an agent's database was locked while the agent wrote to it. */
  transient: Schema.optional(Schema.Boolean),
}) {}

/** ccusage reading an agent's SQLite database while the agent holds a write lock on it (Antigravity, OpenCode, …). */
export const isLockedError = (stderr: string) => /database is locked|SQLITE_BUSY/i.test(stderr);

const Count = Schema.optional(Schema.Finite);

/** Token counts as ccusage reports them; agents leave out the kinds they don't have. */
const Counts = {
  inputTokens: Count,
  outputTokens: Count,
  cacheReadTokens: Count,
  cacheCreationTokens: Count,
  reasoningOutputTokens: Count,
  totalTokens: Count,
};

/** Most agents report cost by model in a list; Codex in a record by model name, without cost. */
const Models = {
  modelBreakdowns: Schema.optional(Schema.Array(Schema.Struct({ modelName: Schema.String, cost: Count, ...Counts }))),
  models: Schema.optional(Schema.Record(Schema.String, Schema.Struct(Counts))),
};

/** Cost in USD: `totalCost` for most agents, `costUSD` for Codex. */
const Cost = { totalCost: Count, costUSD: Count };

const DailyReport = Schema.Struct({
  daily: Schema.Array(Schema.Struct({ date: Schema.String, ...Counts, ...Cost, ...Models })),
});
export type DailyReport = typeof DailyReport.Type;

const SessionReport = Schema.Struct({
  sessions: Schema.Array(
    Schema.Struct({
      sessionId: Schema.String,
      /** Set in the report of all agents. */
      agent: Schema.optional(Schema.String),
      /** Claude Code: the project folder, with its separators turned into dashes. */
      projectPath: Schema.optional(Schema.String),
      firstActivity: Schema.optional(Schema.String),
      lastActivity: Schema.optional(Schema.String),
      ...Counts,
      ...Cost,
      ...Models,
    }),
  ),
});
export type SessionReport = typeof SessionReport.Type;

const BlockReport = Schema.Struct({
  blocks: Schema.Array(
    Schema.Struct({
      isActive: Schema.Boolean,
      startTime: Schema.String,
      endTime: Schema.String,
      costUSD: Schema.Finite,
      totalTokens: Schema.Finite,
      models: Schema.Array(Schema.String),
      burnRate: Schema.optional(Schema.NullOr(Schema.Struct({ costPerHour: Schema.Finite }))),
      projection: Schema.optional(
        Schema.NullOr(Schema.Struct({ remainingMinutes: Schema.Finite, totalCost: Schema.Finite })),
      ),
    }),
  ),
});
export type BlockReport = typeof BlockReport.Type;

/** The report of all agents (`ccusage daily --sections daily,session`): rows by `period`, a date or a session id. */
const UnifiedReport = Schema.Struct({
  daily: Schema.Array(Schema.Struct({ period: Schema.String, ...Counts, ...Cost, ...Models })),
  session: Schema.Array(
    Schema.Struct({
      period: Schema.String,
      agent: Schema.String,
      metadata: Schema.optional(Schema.Struct({ lastActivity: Schema.optional(Schema.String) })),
      ...Counts,
      ...Cost,
      ...Models,
    }),
  ),
});

/** Decoders of ccusage's `--json` output, by report. */
export const decodeDaily = Schema.decodeUnknownEffect(Schema.fromJsonString(DailyReport));
export const decodeSessions = Schema.decodeUnknownEffect(Schema.fromJsonString(SessionReport));
export const decodeBlocks = Schema.decodeUnknownEffect(Schema.fromJsonString(BlockReport));
const decodeUnifiedJson = Schema.decodeUnknownEffect(Schema.fromJsonString(UnifiedReport));

/** The report of all agents, as the reports of one. */
export const decodeUnified = (json: string) =>
  Effect.map(decodeUnifiedJson(json), (report): [DailyReport, SessionReport] => [
    { daily: report.daily.map(({ period, ...row }) => ({ ...row, date: period })) },
    {
      sessions: report.session.map(({ period, metadata, ...row }) => ({
        ...row,
        sessionId: period,
        lastActivity: metadata?.lastActivity,
      })),
    },
  ]);

/** Tokens and their cost in USD. */
export interface CcusageTotals {
  tokens: Tokens;
  cost: number;
}

/** A model's share; `cost` is absent when the agent's report has none by model. */
export interface CcusageModel {
  name: string;
  tokens: Tokens;
  cost?: number;
}

/** What the ccusage view of the Usage tab shows for one source. */
export interface CcusageView {
  source: CcusageSource;
  today: CcusageTotals;
  /** The last 7 and 30 days, today included. */
  week: CcusageTotals;
  month: CcusageTotals;
  all: CcusageTotals;
  /** Newest first. */
  days: Array<CcusageTotals & { day: string; models: CcusageModel[] }>;
  /** Over every day, costliest first. */
  models: CcusageModel[];
  /** Most recent first. */
  sessions: Array<
    CcusageTotals & { id: string; agent?: string; project?: string; firstAt?: number; lastAt?: number; models: string[] }
  >;
  /** By agent, costliest first; only in the report of all agents. */
  agents?: Array<CcusageTotals & { agent: string; sessions: number }>;
  /** Claude Code's 5-hour billing block running now. */
  block?: {
    start: number;
    end: number;
    cost: number;
    tokens: number;
    models: ReadonlyArray<string>;
    costPerHour?: number;
    projectedCost?: number;
  };
}

type CountsOf = { readonly [K in keyof typeof Counts]?: number | undefined };

function tokensOf(c: CountsOf): Tokens {
  const input = c.inputTokens ?? 0;
  const output = c.outputTokens ?? 0;
  const cachedRead = c.cacheReadTokens ?? 0;
  const cachedWrite = c.cacheCreationTokens ?? 0;
  return {
    input,
    output,
    cachedRead,
    cachedWrite,
    thought: c.reasoningOutputTokens ?? 0,
    total: c.totalTokens ?? input + output + cachedRead + cachedWrite,
  };
}

function addTokens(a: Tokens, b: Tokens): Tokens {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cachedRead: a.cachedRead + b.cachedRead,
    cachedWrite: a.cachedWrite + b.cachedWrite,
    thought: a.thought + b.thought,
    total: a.total + b.total,
  };
}

const NONE: CcusageTotals = { tokens: NO_TOKENS, cost: 0 };
const addTotals = (a: CcusageTotals, b: CcusageTotals): CcusageTotals => ({
  tokens: addTokens(a.tokens, b.tokens),
  cost: a.cost + b.cost,
});

function modelsOf(row: { readonly [K in keyof typeof Models]?: (typeof Models)[K]["Type"] }): CcusageModel[] {
  if (row.modelBreakdowns) {
    return row.modelBreakdowns.map((m) => ({ name: m.modelName, tokens: tokensOf(m), cost: m.cost }));
  }
  return Object.entries(row.models ?? {}).map(([name, m]) => ({ name, tokens: tokensOf(m) }));
}

const timeOf = (iso: string | undefined) => {
  const ms = iso === undefined ? NaN : Date.parse(iso);
  return Number.isNaN(ms) ? undefined : ms;
};

/** The reports of one source as the Usage tab shows them, with `today`, `weekStart` and `monthStart` local dates. */
export function toView(
  source: CcusageSource,
  daily: DailyReport,
  sessions: SessionReport,
  blocks: BlockReport | undefined,
  today: string,
  weekStart: string,
  monthStart: string,
): CcusageView {
  const days = daily.daily
    .map((d) => ({ day: d.date, tokens: tokensOf(d), cost: d.totalCost ?? d.costUSD ?? 0, models: modelsOf(d) }))
    .sort((a, b) => b.day.localeCompare(a.day));
  const since = (start: string) => days.filter((d) => d.day >= start && d.day <= today).reduce(addTotals, NONE);
  const byModel = new Map<string, CcusageModel>();
  for (const m of days.flatMap((d) => d.models)) {
    const before = byModel.get(m.name);
    byModel.set(m.name, {
      name: m.name,
      tokens: before ? addTokens(before.tokens, m.tokens) : m.tokens,
      // Unknown for the whole once unknown for a day.
      cost: m.cost === undefined || (before && before.cost === undefined) ? undefined : (before?.cost ?? 0) + m.cost,
    });
  }
  const rows = sessions.sessions
    .map((s) => ({
      id: s.sessionId,
      agent: s.agent,
      project: s.projectPath,
      firstAt: timeOf(s.firstActivity),
      lastAt: timeOf(s.lastActivity),
      models: modelsOf(s).map((m) => m.name),
      tokens: tokensOf(s),
      cost: s.totalCost ?? s.costUSD ?? 0,
    }))
    .sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0));
  const byAgent = new Map<string, CcusageTotals & { agent: string; sessions: number }>();
  for (const s of rows) {
    if (s.agent === undefined) continue;
    const before = byAgent.get(s.agent) ?? { ...NONE, agent: s.agent, sessions: 0 };
    byAgent.set(s.agent, { ...addTotals(before, s), agent: s.agent, sessions: before.sessions + 1 });
  }
  const active = blocks?.blocks.find((b) => b.isActive);
  const start = active && timeOf(active.startTime);
  const end = active && timeOf(active.endTime);
  return {
    source,
    today: days.find((d) => d.day === today) ?? NONE,
    week: since(weekStart),
    month: since(monthStart),
    all: days.reduce(addTotals, NONE),
    days,
    models: [...byModel.values()].sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0) || b.tokens.total - a.tokens.total),
    sessions: rows,
    agents: source === "all" ? [...byAgent.values()].sort((a, b) => b.cost - a.cost || b.tokens.total - a.tokens.total) : undefined,
    block:
      active && start !== undefined && end !== undefined
        ? {
            start,
            end,
            cost: active.costUSD,
            tokens: active.totalTokens,
            models: active.models,
            costPerHour: active.burnRate?.costPerHour,
            projectedCost: active.projection?.totalCost,
          }
        : undefined,
  };
}

/** How long one ccusage run may take, a first npx download included. */
const TIMEOUT = Duration.minutes(3);

/**
 * Token usage and estimated cost from the local logs of coding agents (Claude Code, Codex, …), read by the ccusage
 * CLI: the one set in `codeAcp.ccusagePath`, or a pinned release through `npx -y`. Reports are kept until refreshed.
 */
export class Ccusage extends Context.Service<Ccusage, {
  report(source: CcusageSource, refresh: boolean): Effect.Effect<CcusageView, CcusageError>;
}>()("code-acp/Ccusage") {
  static readonly layer = Layer.effect(
    Ccusage,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const zone = DateTime.zoneMakeLocal();
      const cache = new Map<CcusageSource, CcusageView>();

      /** Runs ccusage with `args` and decodes its JSON output. */
      const run = <A>(args: ReadonlyArray<string>, decode: (json: string) => Effect.Effect<A, Schema.SchemaError>) =>
        Effect.gen(function* () {
          const custom = readSettings().ccusagePath.trim();
          const [command, ...prefix] = custom ? [custom] : ["npx", "-y", `ccusage@${CCUSAGE_VERSION}`];
          const label = [command, ...prefix, ...args].join(" ");
          const fail = (message: string, cause?: unknown, transient?: boolean) =>
            new CcusageError({ message, cause, transient });
          const handle = yield* spawner
            .spawn(
              ChildProcess.make(command, [...prefix, ...args], {
                shell: process.platform === "win32",
                env: { NO_COLOR: "1" },
                extendEnv: true,
              }),
            )
            .pipe(Effect.mapError((err) => fail(t("ccusage.spawnFailed", command, err.message), err)));
          const [stdout, stderr, code] = yield* Effect.all(
            [
              Stream.mkString(Stream.decodeText(handle.stdout)),
              Stream.mkString(Stream.decodeText(handle.stderr)),
              handle.exitCode,
            ],
            { concurrency: "unbounded" },
          ).pipe(Effect.mapError((err) => fail(t("ccusage.spawnFailed", command, err.message), err)));
          if (code !== 0) {
            const detail = stderr.trim().split("\n").filter((line) => !line.startsWith("npm notice")).join("\n");
            return yield* fail(t("ccusage.failed", label, detail || String(code)), undefined, isLockedError(detail));
          }
          return yield* decode(stdout).pipe(
            Effect.mapError((err) => fail(t("ccusage.badOutput", label, err.message), err)),
          );
        }).pipe(
          Effect.scoped,
          Effect.retry({ while: (err) => err.transient === true, schedule: Schedule.spaced("1 second"), times: 3 }),
          Effect.timeoutOrElse({
            duration: TIMEOUT,
            orElse: () => Effect.fail(new CcusageError({ message: t("ccusage.timeout") })),
          }),
        );

      const localDay = (now: DateTime.Utc, daysAgo: number) =>
        DateTime.formatIsoDate(DateTime.subtract(DateTime.setZone(now, zone), { days: daysAgo }));

      const report = Effect.fn("Ccusage.report")(function* (source: CcusageSource, refresh: boolean) {
        const cached = cache.get(source);
        if (cached && !refresh) {
          return cached;
        }
        yield* Effect.logInfo(`[ccusage] ${source}`);
        const [[daily, sessions], blocks] = yield* Effect.all(
          [
            source === "all"
              ? run(["daily", "--json", "--sections", "daily,session"], decodeUnified)
              : Effect.all([run([source, "daily", "--json"], decodeDaily), run([source, "session", "--json"], decodeSessions)], {
                  concurrency: "unbounded",
                }),
            // Billing blocks are a Claude Code thing; ccusage has them for nothing else. Without them the rest still shows.
            source === "all" || source === "claude"
              ? run(["claude", "blocks", "--json", "--active"], decodeBlocks).pipe(
                  Effect.catchTag("CcusageError", (err) => Effect.as(Effect.logWarning(err.message), undefined)),
                )
              : Effect.undefined,
          ],
          { concurrency: "unbounded" },
        );
        const now = yield* DateTime.now;
        const view = toView(source, daily, sessions, blocks, localDay(now, 0), localDay(now, 6), localDay(now, 29));
        cache.set(source, view);
        return view;
      });

      return { report };
    }),
  );
}
