import { Context, DateTime, Effect, FileSystem, Layer, Option, Path, Schema, Semaphore } from "effect";
import * as vscode from "vscode";
import { ExtensionCtx, thenable } from "./runtime";

/** Where earlier versions kept the whole ledger; split into month files on first use. */
const LEGACY_KEY = "codeAcp.usage";
const LEGACY_FILE = "usage.json";
/** The ledger's folder in the global storage: one file a month, `YYYY/MM.json`. */
const LEDGER_DIR = "usage";
const MONTH_FILE = /^(\d{4})[/\\](\d{2})\.json$/;

const Tokens = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cachedRead: Schema.Finite,
  cachedWrite: Schema.Finite,
  thought: Schema.Finite,
  total: Schema.Finite,
});
export type Tokens = typeof Tokens.Type;

/** Amounts by ISO 4217 currency code. */
const Costs = Schema.Record(Schema.String, Schema.Finite);
export type Costs = typeof Costs.Type;

const Cost = Schema.Struct({ amount: Schema.Finite, currency: Schema.String });
export type Cost = typeof Cost.Type;

const Totals = Schema.Struct({ turns: Schema.Int, tokens: Tokens, cost: Costs });
export type Totals = typeof Totals.Type;

const SessionEntry = Schema.Struct({
  ...Totals.fields,
  agentId: Schema.String,
  sessionId: Schema.String,
  title: Schema.optional(Schema.String),
  cwd: Schema.String,
  /** Epoch ms of the first and the latest record. */
  firstAt: Schema.Finite,
  lastAt: Schema.Finite,
  /** The session's cumulative cost as the agent last reported it; the next report adds what it grew by. */
  lastCost: Schema.optional(Cost),
});
export type SessionEntry = typeof SessionEntry.Type;

const Ledger = Schema.Struct({
  /** By local date, `YYYY-MM-DD`. */
  days: Schema.Record(Schema.String, Totals),
  /** By `agentId sessionId`. */
  sessions: Schema.Record(Schema.String, SessionEntry),
});
export type Ledger = typeof Ledger.Type;

/**
 * Token usage of one prompt turn, as agents report it in `PromptResponse.usage` (unstable in ACP, so the stable
 * types leave it out).
 */
const TurnUsage = Schema.Struct({
  totalTokens: Schema.Finite,
  inputTokens: Schema.Finite,
  outputTokens: Schema.Finite,
  thoughtTokens: Schema.optional(Schema.NullOr(Schema.Finite)),
  cachedReadTokens: Schema.optional(Schema.NullOr(Schema.Finite)),
  cachedWriteTokens: Schema.optional(Schema.NullOr(Schema.Finite)),
});
const decodeTurnUsage = Schema.decodeUnknownOption(TurnUsage);
const decodeLedger = Schema.decodeUnknownOption(Ledger);

/** The session a record belongs to. */
export interface SessionRef {
  agentId: string;
  sessionId: string;
  cwd: string;
  title?: string;
}

export const EMPTY_LEDGER: Ledger = { days: {}, sessions: {} };
export const NO_TOKENS: Tokens = { input: 0, output: 0, cachedRead: 0, cachedWrite: 0, thought: 0, total: 0 };
const NO_TOTALS: Totals = { turns: 0, tokens: NO_TOKENS, cost: {} };

const sessionKey = (agentId: string, sessionId: string) => `${agentId} ${sessionId}`;

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

function addCosts(a: Costs, b: Costs): Costs {
  const sum: Record<string, number> = { ...a };
  for (const [currency, amount] of Object.entries(b)) {
    sum[currency] = (sum[currency] ?? 0) + amount;
  }
  return sum;
}

function addTotals(a: Totals, b: Totals): Totals {
  return { turns: a.turns + b.turns, tokens: addTokens(a.tokens, b.tokens), cost: addCosts(a.cost, b.cost) };
}

/** Adds `delta` to the session and to `day`, and refreshes what the session is called. */
function record(ledger: Ledger, ref: SessionRef, day: string, now: number, delta: Totals, lastCost?: Cost): Ledger {
  const key = sessionKey(ref.agentId, ref.sessionId);
  const before = ledger.sessions[key];
  const session: SessionEntry = {
    ...addTotals(before ?? NO_TOTALS, delta),
    agentId: ref.agentId,
    sessionId: ref.sessionId,
    title: ref.title ?? before?.title,
    cwd: ref.cwd,
    firstAt: before?.firstAt ?? now,
    lastAt: now,
    lastCost: lastCost ?? before?.lastCost,
  };
  return {
    days: { ...ledger.days, [day]: addTotals(ledger.days[day] ?? NO_TOTALS, delta) },
    sessions: { ...ledger.sessions, [key]: session },
  };
}

/** Counts a finished turn, with its tokens when the agent reported them. */
export function addTurn(ledger: Ledger, ref: SessionRef, usage: unknown, day: string, now: number): Ledger {
  const tokens = Option.match(decodeTurnUsage(usage), {
    onNone: () => NO_TOKENS,
    onSome: (u): Tokens => ({
      input: u.inputTokens,
      output: u.outputTokens,
      cachedRead: u.cachedReadTokens ?? 0,
      cachedWrite: u.cachedWriteTokens ?? 0,
      thought: u.thoughtTokens ?? 0,
      total: u.totalTokens,
    }),
  });
  return record(ledger, ref, day, now, { turns: 1, tokens, cost: {} });
}

/**
 * Adds what a session's cumulative cost grew by since its last report. `previous` is the last report known from
 * elsewhere (a reopened session), for sessions the ledger hasn't seen. A cost below the last one means the agent
 * counts from zero again (a restarted agent); all of it is new then.
 */
export function addCost(ledger: Ledger, ref: SessionRef, cost: Cost, day: string, now: number, previous?: Cost): Ledger {
  const last = ledger.sessions[sessionKey(ref.agentId, ref.sessionId)]?.lastCost ?? previous;
  const delta = !last || last.currency !== cost.currency || cost.amount < last.amount ? cost.amount : cost.amount - last.amount;
  return record(ledger, ref, day, now, { ...NO_TOTALS, cost: delta > 0 ? { [cost.currency]: delta } : {} }, cost);
}

/** The month a local date falls in, `YYYY-MM`. */
export const monthOf = (day: string) => day.slice(0, 7);

/** A session's records from two months as one: totals summed, the rest from the later one. */
function mergeSession(a: SessionEntry, b: SessionEntry): SessionEntry {
  const [earlier, later] = a.lastAt <= b.lastAt ? [a, b] : [b, a];
  return {
    ...later,
    ...addTotals(a, b),
    title: later.title ?? earlier.title,
    firstAt: Math.min(a.firstAt, b.firstAt),
    lastCost: later.lastCost ?? earlier.lastCost,
  };
}

/** The month ledgers as one; a session kept on across months is summed. */
export function mergeLedgers(ledgers: ReadonlyArray<Ledger>): Ledger {
  const days: Record<string, Totals> = {};
  const sessions: Record<string, SessionEntry> = {};
  for (const ledger of ledgers) {
    for (const [day, totals] of Object.entries(ledger.days)) {
      days[day] = days[day] ? addTotals(days[day], totals) : totals;
    }
    for (const [key, session] of Object.entries(ledger.sessions)) {
      sessions[key] = sessions[key] ? mergeSession(sessions[key], session) : session;
    }
  }
  return { days, sessions };
}

/**
 * A whole ledger as month ledgers by `YYYY-MM`. Days split exactly; a session goes to the month it was last used in,
 * as the old ledger doesn't say what it used in which month.
 */
export function splitByMonth(ledger: Ledger, monthOfTime: (ms: number) => string): Map<string, Ledger> {
  const months = new Map<string, { days: Record<string, Totals>; sessions: Record<string, SessionEntry> }>();
  const monthLedger = (month: string) => {
    let found = months.get(month);
    if (!found) {
      found = { days: {}, sessions: {} };
      months.set(month, found);
    }
    return found;
  };
  for (const [day, totals] of Object.entries(ledger.days)) {
    monthLedger(monthOf(day)).days[day] = totals;
  }
  for (const [key, session] of Object.entries(ledger.sessions)) {
    monthLedger(monthOfTime(session.lastAt)).sessions[key] = session;
  }
  return months;
}

/** Which sessions the usage page lists: those matching `text`, the `limit` most recent. */
export interface SessionQuery {
  text: string;
  limit: number;
}

export type SessionRow = Omit<SessionEntry, "lastCost">;

/** What the usage page shows. */
export interface UsageSummary {
  today: Totals;
  /** The last 7 and 30 days, today included. */
  week: Totals;
  month: Totals;
  /** Everything recorded. */
  all: Totals;
  /** Every recorded day, newest first. */
  days: Array<Totals & { day: string }>;
  /** Totals by agent, busiest first. */
  agents: Array<Totals & { agentId: string; sessions: number }>;
  /** The sessions the query asked for, most recent first. */
  sessions: SessionRow[];
  /** Sessions matching the query, listed or not. */
  sessionCount: number;
}

/**
 * The summary as of `today`, with `weekStart` and `monthStart` the first days of the last 7 and 30. `searchText`
 * adds what a session is also found by, e.g. its agent's name.
 */
export function summarize(
  ledger: Ledger,
  today: string,
  weekStart: string,
  monthStart: string,
  query: SessionQuery,
  searchText: (session: SessionEntry) => string = () => "",
): UsageSummary {
  const days = Object.entries(ledger.days)
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([day, totals]) => ({ day, ...totals }));
  const since = (start: string) => days.filter((d) => d.day >= start && d.day <= today).reduce(addTotals, NO_TOTALS);
  const all = Object.values(ledger.sessions);
  const byAgent = new Map<string, Totals & { agentId: string; sessions: number }>();
  for (const s of all) {
    const before = byAgent.get(s.agentId) ?? { ...NO_TOTALS, agentId: s.agentId, sessions: 0 };
    byAgent.set(s.agentId, { ...before, ...addTotals(before, s), sessions: before.sessions + 1 });
  }
  const text = query.text.trim().toLowerCase();
  const matching = text
    ? all.filter((s) => `${s.title ?? ""} ${s.cwd} ${s.agentId} ${searchText(s)}`.toLowerCase().includes(text))
    : all;
  return {
    today: ledger.days[today] ?? NO_TOTALS,
    week: since(weekStart),
    month: since(monthStart),
    all: days.reduce(addTotals, NO_TOTALS),
    days,
    agents: [...byAgent.values()].sort((a, b) => b.tokens.total - a.tokens.total || b.turns - a.turns),
    sessions: matching
      .sort((a, b) => b.lastAt - a.lastAt)
      .slice(0, query.limit)
      .map(({ lastCost: _, ...session }) => session),
    sessionCount: matching.length,
  };
}

/**
 * Tokens and cost the agents report, by session and by local day, kept for good in the global storage (shared by
 * every workspace): one file a month, `usage/YYYY/MM.json`, so a record rewrites only the current month.
 */
export class UsageLedger extends Context.Service<UsageLedger, {
  /** Fires after every record and after a clear. */
  readonly onDidChange: vscode.Event<void>;
  recordTurn(ref: SessionRef, usage: unknown): Effect.Effect<void>;
  recordCost(ref: SessionRef, cost: Cost, previous?: Cost): Effect.Effect<void>;
  session(agentId: string, sessionId: string): Effect.Effect<Totals | undefined>;
  summary(query: SessionQuery, searchText?: (session: SessionEntry) => string): Effect.Effect<UsageSummary>;
  readonly clear: Effect.Effect<void>;
}>()("code-acp/UsageLedger") {
  static readonly layer = Layer.effect(
    UsageLedger,
    Effect.gen(function* () {
      const context = yield* ExtensionCtx;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const changed = yield* Effect.acquireRelease(
        Effect.sync(() => new vscode.EventEmitter<void>()),
        (emitter) => Effect.sync(() => emitter.dispose()),
      );
      // Serializes read-modify-write in this window; other windows write the same files.
      const lock = yield* Semaphore.make(1);
      const zone = DateTime.zoneMakeLocal();
      const storage = context.globalStorageUri.fsPath;
      const dir = path.join(storage, LEDGER_DIR);
      const legacyFile = path.join(storage, LEGACY_FILE);
      const fileOf = (month: string) => path.join(dir, month.slice(0, 4), `${month.slice(5, 7)}.json`);

      /** The local date `daysAgo` days before now, `YYYY-MM-DD`. */
      const localDay = (daysAgo: number) =>
        Effect.map(DateTime.now, (now) => DateTime.formatIsoDate(DateTime.subtract(DateTime.setZone(now, zone), { days: daysAgo })));
      const monthOfTime = (ms: number) => monthOf(DateTime.formatIsoDate(DateTime.setZone(DateTime.makeUnsafe(ms), zone)));

      const mtimeOf = (file: string) =>
        fs.stat(file).pipe(
          Effect.map((info) => Option.getOrUndefined(info.mtime)?.getTime()),
          Effect.orElseSucceed(() => undefined),
        );

      /** Each month file last read or written, and its mtime then; read again when another window wrote it. */
      const cache = new Map<string, { mtime: number | undefined; ledger: Ledger }>();

      const readMonth = (month: string) =>
        Effect.gen(function* () {
          const file = fileOf(month);
          const mtime = yield* mtimeOf(file);
          const cached = cache.get(month);
          if (cached && cached.mtime === mtime) {
            return cached.ledger;
          }
          const ledger =
            mtime === undefined
              ? EMPTY_LEDGER
              : yield* fs.readFileString(file).pipe(
                  Effect.map((text) => Option.getOrElse(decodeLedger(JSON.parse(text)), () => EMPTY_LEDGER)),
                  // A damaged file starts over rather than failing every turn.
                  Effect.catchCause(() => Effect.succeed(EMPTY_LEDGER)),
                );
          cache.set(month, { mtime, ledger });
          return ledger;
        });

      /** The months on disk, `YYYY-MM`, oldest first. */
      const months = fs.readDirectory(dir, { recursive: true }).pipe(
        Effect.map((entries) =>
          entries
            .flatMap((entry) => {
              const match = MONTH_FILE.exec(entry);
              return match ? [`${match[1]}-${match[2]}`] : [];
            })
            .sort(),
        ),
        Effect.orElseSucceed((): string[] => []),
      );

      /** Every month as one ledger. */
      const readAll = Effect.gen(function* () {
        const found = yield* months;
        for (const month of cache.keys()) {
          if (!found.includes(month)) {
            cache.delete(month);
          }
        }
        return mergeLedgers(yield* Effect.forEach(found, readMonth));
      });

      const writeMonth = (month: string, ledger: Ledger) =>
        Effect.gen(function* () {
          const file = fileOf(month);
          yield* fs.makeDirectory(path.dirname(file), { recursive: true });
          // Written aside, then renamed over: a reader never sees half a file.
          const temp = `${file}.${process.pid}.tmp`;
          yield* fs.writeFileString(temp, JSON.stringify(ledger));
          yield* fs.rename(temp, file);
          cache.set(month, { mtime: yield* mtimeOf(file), ledger });
        });

      /** Usage is a nicety: a failed write must not break the chat. */
      const logFailure = Effect.catch((err: { message: string }) => Effect.logWarning(`Saving usage failed: ${err.message}`));

      /** Splits the ledger earlier versions kept whole (in `usage.json`, or before that in globalState) into months. */
      const migrate = Effect.gen(function* () {
        if (yield* fs.exists(dir)) {
          return;
        }
        const fromFile = yield* fs.readFileString(legacyFile).pipe(
          Effect.map((text) => decodeLedger(JSON.parse(text))),
          Effect.orElseSucceed(() => Option.none<Ledger>()),
        );
        const old = Option.orElse(fromFile, () => decodeLedger(context.globalState.get(LEGACY_KEY)));
        if (Option.isSome(old)) {
          yield* Effect.forEach(splitByMonth(old.value, monthOfTime), ([month, ledger]) => writeMonth(month, ledger), {
            discard: true,
          });
        }
        yield* fs.remove(legacyFile, { force: true });
        if (context.globalState.get(LEGACY_KEY) !== undefined) {
          yield* thenable(() => context.globalState.update(LEGACY_KEY, undefined));
        }
      }).pipe(logFailure);
      yield* lock.withPermits(1)(migrate);

      const modify = (f: (month: Ledger, all: Ledger, day: string, now: number) => Ledger) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const day = yield* localDay(0);
            const now = DateTime.toEpochMillis(yield* DateTime.now);
            const month = monthOf(day);
            yield* writeMonth(month, f(yield* readMonth(month), yield* readAll, day, now));
            changed.fire();
          }).pipe(logFailure),
        );

      const recordTurn = (ref: SessionRef, usage: unknown) =>
        modify((ledger, _, day, now) => addTurn(ledger, ref, usage, day, now)).pipe(Effect.withSpan("UsageLedger.recordTurn"));

      // A session kept on from an earlier month has its last cost there.
      const recordCost = (ref: SessionRef, cost: Cost, previous?: Cost) =>
        modify((ledger, all, day, now) =>
          addCost(ledger, ref, cost, day, now, all.sessions[sessionKey(ref.agentId, ref.sessionId)]?.lastCost ?? previous),
        ).pipe(Effect.withSpan("UsageLedger.recordCost"));

      const session = (agentId: string, sessionId: string) =>
        Effect.map(readAll, (ledger): Totals | undefined => {
          const entry = ledger.sessions[sessionKey(agentId, sessionId)];
          return entry && { turns: entry.turns, tokens: entry.tokens, cost: entry.cost };
        });

      const summary = (query: SessionQuery, searchText?: (session: SessionEntry) => string) =>
        Effect.gen(function* () {
          return summarize(yield* readAll, yield* localDay(0), yield* localDay(6), yield* localDay(29), query, searchText);
        });

      const clear = lock.withPermits(1)(
        Effect.gen(function* () {
          yield* fs.remove(dir, { recursive: true, force: true });
          cache.clear();
          changed.fire();
        }).pipe(logFailure),
      );

      return UsageLedger.of({ onDidChange: changed.event, recordTurn, recordCost, session, summary, clear });
    }),
  );
}
