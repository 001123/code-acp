import type * as acp from "@agentclientprotocol/sdk";
import { Deferred, Effect, Schema, Scope } from "effect";
import { execa } from "execa";
import * as os from "node:os";
import * as vscode from "vscode";
import { t } from "./i18n";
import { stopProcess } from "./processTree";

/** A terminal's state as the chat shows it. */
export interface TerminalSnapshot {
  readonly sessionId: string;
  readonly terminalId: string;
  /** The command line, for display. */
  readonly command: string;
  /** The end of the output, at most `SNAPSHOT_CHARS` long. */
  readonly output: string;
  /** Set when output was dropped, by the byte limit or for the snapshot. */
  readonly truncated: boolean;
  /** Undefined while the command runs. */
  readonly exitStatus?: acp.TerminalExitStatus;
}

/** The ACP `terminal/*` methods for one agent process. */
export interface AgentTerminals {
  create(request: acp.CreateTerminalRequest): Effect.Effect<acp.CreateTerminalResponse>;
  output(request: acp.TerminalOutputRequest): Effect.Effect<acp.TerminalOutputResponse, TerminalNotFoundError>;
  waitForExit(request: acp.WaitForTerminalExitRequest): Effect.Effect<acp.WaitForTerminalExitResponse, TerminalNotFoundError>;
  kill(request: acp.KillTerminalRequest): Effect.Effect<acp.KillTerminalResponse, TerminalNotFoundError>;
  release(request: acp.ReleaseTerminalRequest): Effect.Effect<acp.ReleaseTerminalResponse, TerminalNotFoundError>;
}

export class TerminalNotFoundError extends Schema.TaggedError<TerminalNotFoundError>()("TerminalNotFoundError", {
  message: Schema.String,
}) {}

/** Output kept when the agent sets no `outputByteLimit`. */
const DEFAULT_OUTPUT_BYTES = 1024 * 1024;

/** Characters of output sent to the chat per snapshot; it shows the end of the output. */
const SNAPSHOT_CHARS = 20_000;

/** Snapshots of a running command are sent at most this often. */
const SNAPSHOT_DELAY_MS = 150;

interface Terminal {
  readonly sessionId: string;
  readonly command: string;
  readonly limit: number;
  readonly exited: Deferred.Deferred<acp.TerminalExitStatus>;
  readonly kill: () => void;
  text: string;
  /** UTF-8 size of `text`; trimmed back to `limit` lazily, since a chatty command appends many small chunks. */
  bytes: number;
  truncated: boolean;
  exitStatus?: acp.TerminalExitStatus;
  timer?: ReturnType<typeof setTimeout>;
}

/** Drops the start of `terminal.text` so it fits `limit` bytes, cutting at a character boundary. */
function trim(terminal: Terminal): void {
  if (terminal.bytes <= terminal.limit) {
    return;
  }
  const bytes = Buffer.from(terminal.text, "utf8");
  // A cut inside a character decodes to U+FFFD; drop those leftovers.
  terminal.text = bytes.subarray(bytes.length - terminal.limit).toString("utf8").replace(/^\uFFFD+/, "");
  terminal.bytes = Buffer.byteLength(terminal.text, "utf8");
  terminal.truncated = true;
}

function quoteArg(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `"${arg.replace(/(["\\$`])/g, "\\$1")}"`;
}

/**
 * Runs the commands an agent asks for, as plain processes (no shell integration or TTY). `onChange` gets a
 * snapshot as output comes in and when a command exits; every process is killed when the Scope closes.
 */
export const makeAgentTerminals = Effect.fn("makeAgentTerminals")(function* (
  onChange: (snapshot: TerminalSnapshot) => void,
): Effect.fn.Return<AgentTerminals, never, Scope.Scope> {
  const terminals = new Map<string, Terminal>();
  let nextId = 1;

  const snapshot = (terminalId: string, terminal: Terminal): TerminalSnapshot => {
    trim(terminal);
    const clipped = terminal.text.length > SNAPSHOT_CHARS;
    return {
      sessionId: terminal.sessionId,
      terminalId,
      command: terminal.command,
      output: clipped ? terminal.text.slice(-SNAPSHOT_CHARS) : terminal.text,
      truncated: terminal.truncated || clipped,
      exitStatus: terminal.exitStatus,
    };
  };

  const notify = (terminalId: string, terminal: Terminal, now: boolean) => {
    if (now) {
      clearTimeout(terminal.timer);
      terminal.timer = undefined;
      onChange(snapshot(terminalId, terminal));
    } else if (!terminal.timer) {
      terminal.timer = setTimeout(() => {
        terminal.timer = undefined;
        onChange(snapshot(terminalId, terminal));
      }, SNAPSHOT_DELAY_MS);
    }
  };

  const find = (request: { sessionId: string; terminalId: string }) => {
    const terminal = terminals.get(request.terminalId);
    return terminal && terminal.sessionId === request.sessionId
      ? Effect.succeed(terminal)
      : Effect.fail(new TerminalNotFoundError({ message: t("terminal.notFound", request.terminalId) }));
  };

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const terminal of terminals.values()) {
        clearTimeout(terminal.timer);
        terminal.kill();
      }
      terminals.clear();
    }),
  );

  const create = Effect.fn("AgentTerminals.create")(function* (request: acp.CreateTerminalRequest) {
    const terminalId = `terminal-${nextId++}`;
    const args = request.args ?? [];
    const cwd = request.cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
    const exited = yield* Deferred.make<acp.TerminalExitStatus>();
    // Agents often send a whole command line without arguments; a shell runs it as typed.
    const child = execa(request.command, args, {
      cwd,
      env: Object.fromEntries((request.env ?? []).map((v) => [v.name, v.value])),
      shell: args.length === 0,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      buffer: false,
      reject: false,
    });
    let ended = false;
    const terminal: Terminal = {
      sessionId: request.sessionId,
      command: [request.command, ...args.map(quoteArg)].join(" "),
      limit: request.outputByteLimit ?? DEFAULT_OUTPUT_BYTES,
      exited,
      kill: () => stopProcess(child, () => ended),
      text: "",
      bytes: 0,
      truncated: false,
    };
    const append = (chunk: string) => {
      terminal.text += chunk;
      terminal.bytes += Buffer.byteLength(chunk, "utf8");
      if (terminal.bytes > 2 * terminal.limit) {
        trim(terminal);
      }
      notify(terminalId, terminal, false);
    };
    child.stdout.setEncoding("utf8").on("data", append);
    child.stderr.setEncoding("utf8").on("data", append);
    // With `reject: false` this settles once, on exit or on a failed spawn (e.g. command not found).
    void child.then((result) => {
      ended = true;
      if (result.failed && result.exitCode === undefined && result.signal === undefined) {
        append(`${result.originalMessage || result.shortMessage}\n`);
      }
      terminal.exitStatus = { exitCode: result.exitCode ?? null, signal: result.signal ?? null };
      Deferred.doneUnsafe(exited, Effect.succeed(terminal.exitStatus));
      notify(terminalId, terminal, true);
    });
    terminals.set(terminalId, terminal);
    notify(terminalId, terminal, true);
    return { terminalId } satisfies acp.CreateTerminalResponse;
  });

  return {
    create,
    output: (request) =>
      Effect.map(find(request), (terminal) => {
        trim(terminal);
        return { output: terminal.text, truncated: terminal.truncated, exitStatus: terminal.exitStatus ?? null };
      }),
    waitForExit: (request) => Effect.flatMap(find(request), (terminal) => Deferred.await(terminal.exited)),
    kill: (request) =>
      Effect.map(find(request), (terminal) => {
        terminal.kill();
        return {};
      }),
    release: (request) =>
      Effect.map(find(request), (terminal) => {
        // Tool calls may still show the terminal: its last snapshot stays in the chat.
        terminal.kill();
        terminals.delete(request.terminalId);
        return {};
      }),
  };
});
