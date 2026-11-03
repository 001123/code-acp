import { Option, Schema } from "effect";

/** What is known about a finished turn ("turnTrace" message); what the agent did not report is left out. */
export const TurnTrace = Schema.Struct({
  stopReason: Schema.String,
  durationMs: Schema.Finite,
  /** Until the agent's first text, thought or tool call. */
  firstResponseMs: Schema.optional(Schema.Finite),
  /** The time the turn waited for the user to allow a tool call or answer a question. */
  waiting: Schema.Struct({ asks: Schema.Finite, ms: Schema.Finite }),
  /** The tool calls made, subagents' too; `kinds` counts them by ACP's `ToolKind`. */
  tools: Schema.Struct({ total: Schema.Finite, failed: Schema.Finite, kinds: Schema.Record(Schema.String, Schema.Finite) }),
  subagents: Schema.Finite,
  /** What changed in the work tree during the turn, whoever did it; left out when there are no checkpoints. */
  changes: Schema.optional(Schema.Struct({ files: Schema.Finite, added: Schema.Finite, removed: Schema.Finite })),
  /** Which turn of the session this was, as far as the usage ledger knows. */
  number: Schema.optional(Schema.Finite),
  /** The agent's name and version. */
  agent: Schema.optional(Schema.String),
  sessionId: Schema.String,
  model: Schema.optional(Schema.String),
  effort: Schema.optional(Schema.String),
  /** The turn's tokens. */
  tokens: Schema.optional(
    Schema.Struct({
      total: Schema.Finite,
      input: Schema.Finite,
      output: Schema.Finite,
      cachedRead: Schema.optional(Schema.Finite),
      cachedWrite: Schema.optional(Schema.Finite),
      thought: Schema.optional(Schema.Finite),
    }),
  ),
  /** The tokens in the session's context when the turn ended. */
  context: Schema.optional(Schema.Struct({ used: Schema.Finite, size: Schema.Finite })),
  /** What the turn cost, worked out from the session's cumulative cost. */
  cost: Schema.optional(Schema.Struct({ turn: Schema.Finite, session: Schema.Finite, currency: Schema.String })),
});
export type TurnTrace = typeof TurnTrace.Type;

const SavedTrace = Schema.Struct({
  turn: Schema.Int,
  /** Position of the turn's user message in the session's history, from 0, to find the message again when it replays. */
  message: Schema.Int,
  trace: TurnTrace,
});
type SavedTrace = typeof SavedTrace.Type;

/** A tab's traces as saved in workspaceState. */
const SavedTraces = Schema.Struct({ messages: Schema.Int, traces: Schema.Array(SavedTrace) });
type SavedTraces = typeof SavedTraces.Type;

/** Traces kept per tab; older ones are dropped. */
const MAX_TRACES = 100;

/** The traces of a tab's session: session/load replays the conversation, but knows nothing of them. */
export class TurnTraces {
  private traces: ReadonlyArray<SavedTrace> = [];
  /** User messages in the session's history so far. */
  private messages = 0;

  /** `saved` is decoded here, so that traces a later version can't read don't cost the tabs they were saved with. */
  static fromSaved(saved: unknown): TurnTraces {
    const traces = new TurnTraces();
    const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(SavedTraces)(saved));
    if (decoded) {
      traces.traces = decoded.traces;
      traces.messages = decoded.messages;
    }
    return traces;
  }

  get saved(): SavedTraces | undefined {
    return this.messages === 0 ? undefined : { messages: this.messages, traces: this.traces };
  }

  /** Counts a user message sent to the session; its position. */
  countMessage(): number {
    return this.messages++;
  }

  add(turn: number, message: number, trace: TurnTrace): void {
    this.traces = [...this.traces, { turn, message, trace }].slice(-MAX_TRACES);
  }

  /** Forgets the traces from `turn` on: their messages are gone from the chat. */
  forgetFrom(turn: number): void {
    this.traces = this.traces.filter((each) => each.turn < turn);
  }

  /** The tab has another session now. */
  clear(): void {
    this.traces = [];
    this.messages = 0;
  }

  /**
   * After the session's history replayed with `turns` for its user messages, in order: moves each trace onto its
   * message's turn, and returns them. When the count differs from the one kept, the positions can't be trusted and
   * the traces are dropped.
   */
  matchReplay(turns: ReadonlyArray<number>): ReadonlyArray<{ turn: number; trace: TurnTrace }> {
    const matches = this.messages === turns.length;
    this.traces = matches
      ? this.traces.flatMap((each) => {
          const turn = turns[each.message];
          return turn === undefined ? [] : [{ ...each, turn }];
        })
      : [];
    this.messages = turns.length;
    return this.traces.map(({ turn, trace }) => ({ turn, trace }));
  }
}
