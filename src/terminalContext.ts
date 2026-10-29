import { Context, Effect, FiberSet, Layer, Option, Stream } from "effect";
import * as vscode from "vscode";
import type { Attachment } from "./chat/protocol";
import { t } from "./i18n";
import { thenable, type VscodeError } from "./runtime";

/** A recent terminal command offered after "@". */
export interface TerminalSuggestion {
  id: number;
  /** The command line. */
  label: string;
  /** Terminal name and exit code. */
  detail: string;
}

/** A command run in a terminal with shell integration. */
interface Command {
  readonly id: number;
  readonly terminal: vscode.Terminal;
  commandLine: string;
  readonly cwd: string | undefined;
  /** Undefined while running, or when the shell did not report it. */
  exitCode: number | undefined;
  running: boolean;
  /** Output as written, escape sequences included, in chunks; only about the last `MAX_RAW` characters are kept. */
  chunks: string[];
  /** Characters in `chunks`. */
  size: number;
}

/** Commands kept per terminal. */
const MAX_COMMANDS = 20;
/** Raw output kept per command, in characters; up to twice as much is held between trims. */
const MAX_RAW = 256 * 1024;
/** Output lines an attachment keeps; earlier ones are cut. */
const MAX_LINES = 200;
/** Terminal commands offered after "@". */
const MAX_SUGGESTIONS = 5;
const MAX_LABEL = 40;

/** OSC (incl. shell integration's 633), DCS/PM/APC/SOS, CSI and two-byte escape sequences. */
const ESCAPES = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[P^_X][^\x1b]*\x1b\\|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[ -/]*[0-~]/g;

/** Terminal output as plain text: no escape sequences, lines redrawn after "\r" keep their last state. */
export function plainOutput(raw: string): string {
  const lines = raw
    .replace(ESCAPES, "")
    .split("\n")
    .map((line) => {
      const l = line.replace(/\r+$/, "");
      return l.slice(l.lastIndexOf("\r") + 1).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
    });
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
  while (lines.length && !lines[0]!.trim()) lines.shift();
  return lines.length > MAX_LINES ? ["…", ...lines.slice(-MAX_LINES)].join("\n") : lines.join("\n");
}

function rawOf(command: Command): string {
  return command.chunks.join("").slice(-MAX_RAW);
}

function short(text: string): string {
  return text.length > MAX_LABEL ? `${text.slice(0, MAX_LABEL - 1)}…` : text;
}

/**
 * Terminal content for the chat: output of recent commands (read through shell integration, which only
 * sees commands that start after activation, i.e. once VS Code has started) and the selected text.
 */
export class TerminalContext extends Context.Service<TerminalContext, {
  readonly suggestions: (query: string) => Effect.Effect<ReadonlyArray<TerminalSuggestion>>;
  /** The command offered as a suggestion, as an attachment. */
  readonly command: (id: number) => Effect.Effect<Option.Option<Attachment>>;
  /** The newest command of `terminal`, running or not; none without shell integration or commands. */
  readonly lastCommand: (terminal: vscode.Terminal) => Effect.Effect<Option.Option<Attachment>>;
  /** The newest command of `terminal` that exited with a non-zero code. */
  readonly lastFailed: (terminal: vscode.Terminal) => Effect.Effect<Option.Option<Attachment>>;
  /**
   * The active terminal's selection. The API has no terminal selection, so it goes through the clipboard,
   * whose text is put back afterwards.
   */
  readonly selection: Effect.Effect<Option.Option<Attachment>, VscodeError>;
}>()("code-acp/TerminalContext") {
  static readonly layer = Layer.effect(
    TerminalContext,
    Effect.gen(function* () {
      const history = new Map<vscode.Terminal, Command[]>();
      const byExecution = new WeakMap<vscode.TerminalShellExecution, Command>();
      let nextId = 1;
      const run = yield* FiberSet.makeRuntime<never>();

      const started = (e: vscode.TerminalShellExecutionStartEvent) => {
        const command: Command = {
          id: nextId++,
          terminal: e.terminal,
          commandLine: e.execution.commandLine.value,
          cwd: e.execution.cwd?.fsPath,
          exitCode: undefined,
          running: true,
          chunks: [],
          size: 0,
        };
        const list = history.get(e.terminal) ?? [];
        list.push(command);
        history.set(e.terminal, list.slice(-MAX_COMMANDS));
        byExecution.set(e.execution, command);
        // Output is only there for a reader that starts with the command.
        const output = e.execution.read();
        run(
          Stream.fromAsyncIterable(output, (cause) => cause).pipe(
            Stream.runForEach((chunk) =>
              Effect.sync(() => {
                // Appending is cheap; the tail is cut only once twice the limit has piled up.
                command.chunks.push(chunk);
                command.size += chunk.length;
                if (command.size > 2 * MAX_RAW) {
                  const tail = rawOf(command);
                  command.chunks = [tail];
                  command.size = tail.length;
                }
              }),
            ),
            Effect.ignore,
          ),
        );
      };
      const ended = (e: vscode.TerminalShellExecutionEndEvent) => {
        const command = byExecution.get(e.execution);
        if (command) {
          command.running = false;
          command.exitCode = e.exitCode;
          // More accurate once the command has run.
          command.commandLine = e.execution.commandLine.value || command.commandLine;
        }
      };
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          vscode.Disposable.from(
            vscode.window.onDidStartTerminalShellExecution(started),
            vscode.window.onDidEndTerminalShellExecution(ended),
            vscode.window.onDidCloseTerminal((terminal) => history.delete(terminal)),
          ),
        ),
        (d) => Effect.sync(() => d.dispose()),
      );

      const status = (c: Command) =>
        c.running ? t("terminal.running") : c.exitCode === undefined ? "" : t("terminal.exitCode", c.exitCode);

      const attachment = (c: Command): Attachment => ({
        kind: "terminal",
        name: `${c.terminal.name}: ${short(c.commandLine)}`,
        terminal: c.terminal.name,
        shell: c.terminal.state.shell,
        commandLine: c.commandLine,
        cwd: c.cwd,
        exitCode: c.running ? undefined : c.exitCode,
        text: plainOutput(rawOf(c)),
      });

      const newestFirst = () => [...history.values()].flat().sort((a, b) => b.id - a.id);

      const suggestions = (query: string) =>
        Effect.sync(() => {
          const q = query.toLowerCase();
          return newestFirst()
            .filter((c) => c.commandLine.trim() && (c.commandLine.toLowerCase().includes(q) || c.terminal.name.toLowerCase().includes(q)))
            .slice(0, MAX_SUGGESTIONS)
            .map((c): TerminalSuggestion => ({
              id: c.id,
              label: `$ ${c.commandLine}`,
              detail: [c.terminal.name, status(c)].filter(Boolean).join(" · "),
            }));
        });

      const command = (id: number) =>
        Effect.sync(() => Option.map(Option.fromUndefinedOr(newestFirst().find((c) => c.id === id)), attachment));

      const lastCommand = (terminal: vscode.Terminal) =>
        Effect.sync(() => Option.map(Option.fromUndefinedOr(history.get(terminal)?.at(-1)), attachment));

      const lastFailed = (terminal: vscode.Terminal) =>
        Effect.sync(() =>
          Option.map(Option.fromUndefinedOr(history.get(terminal)?.filter((c) => !c.running && !!c.exitCode).at(-1)), attachment),
        );

      const selection = Effect.gen(function* () {
        const terminal = vscode.window.activeTerminal;
        if (!terminal) {
          return Option.none<Attachment>();
        }
        const clipboard = vscode.env.clipboard;
        const saved = yield* thenable(() => clipboard.readText());
        // Emptied first: an empty clipboard afterwards means nothing was selected.
        const text = yield* Effect.gen(function* () {
          yield* thenable(() => clipboard.writeText(""));
          yield* thenable(() => vscode.commands.executeCommand("workbench.action.terminal.copySelection"));
          return yield* thenable(() => clipboard.readText());
        }).pipe(Effect.ensuring(thenable(() => clipboard.writeText(saved)).pipe(Effect.ignore)));
        return text.trim()
          ? Option.some<Attachment>({
              kind: "terminal",
              name: t("terminal.selection", terminal.name),
              terminal: terminal.name,
              shell: terminal.state.shell,
              cwd: terminal.shellIntegration?.cwd?.fsPath,
              text,
            })
          : Option.none<Attachment>();
      }).pipe(Effect.withSpan("TerminalContext.selection"));

      return TerminalContext.of({ suggestions, command, lastCommand, lastFailed, selection });
    }),
  );
}
