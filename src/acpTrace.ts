import { Context, Effect, Layer, Option, Predicate, Schema } from "effect";
import * as vscode from "vscode";
import { t } from "./i18n";
import { readSettings } from "./settings";

const MASK = "***";

/** Longer strings are cut in the log: pasted images and whole files would drown out the rest. */
const MAX_STRING_LENGTH = 20_000;

/** How long streamed text waits for more of it before its line is written. */
const FLUSH_AFTER_MS = 500;

/** Name and value pairs (or records) that hold secrets in ACP: an MCP server's `env` and `headers`, a terminal's `env`. */
const SECRET_GROUP = /^(env|headers)$/i;
const SECRET_KEY = /api[-_]?key|token|secret|password|authorization|credential|cookie/i;

const maskPair = (pair: unknown): unknown => (Predicate.isObject(pair) && "value" in pair ? { ...pair, value: MASK } : MASK);

function maskGroup(group: unknown): unknown {
  if (Array.isArray(group)) return group.map(maskPair);
  if (Predicate.isObject(group)) return Object.fromEntries(Object.keys(group).map((key) => [key, MASK]));
  return MASK;
}

/** `value` as it goes in the log: secrets masked by the name of their field, long strings cut. */
export function sanitize(value: unknown, key = ""): unknown {
  if (Predicate.isNullish(value)) return value;
  if (SECRET_GROUP.test(key)) return maskGroup(value);
  if (Predicate.isString(value)) {
    if (SECRET_KEY.test(key)) return MASK;
    return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}…[+${value.length - MAX_STRING_LENGTH}]` : value;
  }
  if (Array.isArray(value)) return value.map((item) => sanitize(item, key));
  if (Predicate.isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitize(v, k)]));
  return value;
}

/** A streamed piece of text with nothing else in it, so that joining such pieces loses nothing. */
const TextChunk = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  method: Schema.Literal("session/update"),
  params: Schema.Struct({
    sessionId: Schema.String,
    update: Schema.Struct({
      sessionUpdate: Schema.Literals(["agent_message_chunk", "agent_thought_chunk", "user_message_chunk"]),
      messageId: Schema.optional(Schema.NullOr(Schema.String)),
      content: Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
    }),
  }),
});
type TextChunk = typeof TextChunk.Type;
const decodeTextChunk = Schema.decodeUnknownOption(TextChunk);

const sameStream = (a: TextChunk, b: TextChunk) =>
  a.params.sessionId === b.params.sessionId &&
  a.params.update.sessionUpdate === b.params.update.sessionUpdate &&
  a.params.update.messageId === b.params.update.messageId;

type Direction = "→" | "←";

interface PendingText {
  readonly at: number;
  readonly direction: Direction;
  readonly first: TextChunk;
  text: string;
  chunks: number;
}

/**
 * Writes the messages of one connection as lines, joining streamed text so one reply isn't hundreds of lines. It must
 * never get in the way of the connection, so a message it cannot write is left out of the log.
 */
export function makeTraceLog(write: (line: string) => void, enabled: () => boolean, label: string) {
  let pending: PendingText | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const writeLine = (at: number, direction: Direction, message: unknown, chunks = 1) =>
    write(`${new Date(at).toISOString()} [${label}] ${direction}${chunks > 1 ? ` ×${chunks}` : ""} ${JSON.stringify(sanitize(message))}`);

  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    if (!pending) return;
    const { at, direction, first, text, chunks } = pending;
    pending = undefined;
    try {
      const { update } = first.params;
      writeLine(at, direction, { ...first, params: { ...first.params, update: { ...update, content: { ...update.content, text } } } }, chunks);
    } catch {
      // See above.
    }
  };

  const record = (direction: Direction, message: unknown) => {
    if (!enabled()) return;
    const chunk = Option.getOrUndefined(decodeTextChunk(message, { onExcessProperty: "error" }));
    if (chunk && pending && pending.direction === direction && sameStream(pending.first, chunk)) {
      pending.text += chunk.params.update.content.text;
      pending.chunks++;
      return;
    }
    flush();
    if (chunk) {
      pending = { at: Date.now(), direction, first: chunk, text: chunk.params.update.content.text, chunks: 1 };
      timer = setTimeout(flush, FLUSH_AFTER_MS);
      timer.unref();
      return;
    }
    try {
      writeLine(Date.now(), direction, message);
    } catch {
      // See above.
    }
  };

  return { record, flush };
}

export type TraceLog = ReturnType<typeof makeTraceLog>;

/** The same stream, with the messages going through it recorded in `log`. */
export function tapStream<M>(stream: { readable: ReadableStream<M>; writable: WritableStream<M> }, log: TraceLog) {
  const writer = stream.writable.getWriter();
  return {
    readable: stream.readable.pipeThrough(
      new TransformStream<M, M>({
        transform(message, controller) {
          log.record("←", message);
          controller.enqueue(message);
        },
        flush: log.flush,
      }),
    ),
    writable: new WritableStream<M>({
      write(message) {
        log.record("→", message);
        return writer.write(message);
      },
      close() {
        log.flush();
        return writer.close();
      },
      abort(reason) {
        return writer.abort(reason);
      },
    }),
  };
}

/** The log of the messages exchanged with agents, kept while codeAcp.tracing is on. */
export class AcpTrace extends Context.Service<
  AcpTrace,
  {
    /** `stream` with its messages logged under `label`; streams stay tapped, so the setting applies to running agents. */
    tap<M>(stream: { readable: ReadableStream<M>; writable: WritableStream<M> }, label: string): typeof stream;
    readonly show: Effect.Effect<void>;
  }
>()("code-acp/AcpTrace") {
  static readonly layer = Layer.effect(
    AcpTrace,
    Effect.gen(function* () {
      let enabled = readSettings().tracing;
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration("codeAcp.tracing")) {
              enabled = readSettings().tracing;
            }
          }),
        ),
        (listener) => Effect.sync(() => listener.dispose()),
      );
      // Created on first use, so the channel isn't listed for those who never turn this on.
      let channel: vscode.OutputChannel | undefined;
      const open = () => (channel ??= vscode.window.createOutputChannel(t("trace.channel")));
      yield* Effect.addFinalizer(() => Effect.sync(() => channel?.dispose()));
      return AcpTrace.of({
        tap: (stream, label) =>
          tapStream(
            stream,
            makeTraceLog((line) => open().appendLine(line), () => enabled, label),
          ),
        show: Effect.sync(() => open().show(true)),
      });
    }),
  );
}
