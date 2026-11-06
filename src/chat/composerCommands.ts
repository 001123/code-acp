import { Effect, Option } from "effect";
import * as vscode from "vscode";
import { t } from "../i18n";
import { Problems, type ProblemScope } from "../problems";
import type { VscodeError } from "../runtime";
import { TerminalContext } from "../terminalContext";
import { selectionAttachments, uriAttachments, type AttachmentQueue } from "./attachments";
import type { Attachment } from "./protocol";

/** The commands that add something from VS Code to the composer and show the chat. */
export class ComposerCommands {
  constructor(
    private readonly attachments: AttachmentQueue,
    private readonly focus: Effect.Effect<unknown, VscodeError>,
  ) {}

  /** Adds attachments, after `prompt` when there is one, to the composer and shows the chat. */
  private readonly queueAndFocus = Effect.fn("ComposerCommands.queueAndFocus")(function* (
    this: ComposerCommands,
    attachments: Attachment[],
    prompt?: string,
  ) {
    // Queued first: they reach the composer once the view shows, even if focusing fails.
    this.attachments.add(attachments, prompt);
    yield* this.focus;
  });

  /** Adds files/folders to the composer (Explorer / editor tab context menu). */
  readonly attach = Effect.fn("ComposerCommands.attach")(function* (
    this: ComposerCommands,
    uris: ReadonlyArray<vscode.Uri>,
  ) {
    yield* this.queueAndFocus(uriAttachments(uris));
  });

  /** Adds the editor's non-empty selections to the composer as snippets (editor context menu). */
  readonly attachSelection = Effect.fn("ComposerCommands.attachSelection")(function* (
    this: ComposerCommands,
    editor: vscode.TextEditor,
  ) {
    yield* this.queueAndFocus(selectionAttachments(editor));
  });

  /** Adds `prompt` and the editor's non-empty selections to the composer ("Ask Code ACP" menu and code actions). */
  readonly askAboutSelection = Effect.fn("ComposerCommands.askAboutSelection")(function* (
    this: ComposerCommands,
    editor: vscode.TextEditor,
    prompt: string,
  ) {
    const attachments = selectionAttachments(editor);
    if (attachments.length) {
      yield* this.queueAndFocus(attachments, prompt);
    }
  });

  /** Adds the active terminal's selection to the composer (terminal context menu). */
  readonly attachTerminalSelection = Effect.fn("ComposerCommands.attachTerminalSelection")(function* (
    this: ComposerCommands,
  ) {
    const selection = yield* (yield* TerminalContext).selection;
    if (Option.isNone(selection)) {
      void vscode.window.showInformationMessage(t("terminal.noSelection"));
      return;
    }
    yield* this.queueAndFocus([selection.value]);
  });

  /**
   * Adds the output of the active terminal's last command, or last failed one, to the composer
   * (terminal context menu).
   */
  readonly attachTerminalOutput = Effect.fn("ComposerCommands.attachTerminalOutput")(function* (
    this: ComposerCommands,
    failed: boolean,
  ) {
    const terminal = vscode.window.activeTerminal;
    if (!terminal) {
      return;
    }
    const terminals = yield* TerminalContext;
    const command = yield* failed ? terminals.lastFailed(terminal) : terminals.lastCommand(terminal);
    if (Option.isNone(command)) {
      const reason = !terminal.shellIntegration
        ? "terminal.noShellIntegration"
        : failed
          ? "terminal.noFailed"
          : "terminal.noCommands";
      void vscode.window.showInformationMessage(t(reason));
      return;
    }
    yield* this.queueAndFocus([command.value]);
  });

  /** Adds the problems of the active editor's file, or of the workspace, to the composer. */
  readonly attachProblems = Effect.fn("ComposerCommands.attachProblems")(function* (
    this: ComposerCommands,
    scope: ProblemScope,
  ) {
    const attachment = yield* (yield* Problems).attachment(scope);
    if (Option.isNone(attachment)) {
      void vscode.window.showInformationMessage(t(scope === "file" ? "problems.noneInFile" : "problems.none"));
      return;
    }
    yield* this.queueAndFocus([attachment.value]);
  });

  /** Adds problems and the code around them to the composer ("Fix with Code ACP" quick fix). */
  readonly fixProblems = Effect.fn("ComposerCommands.fixProblems")(function* (
    this: ComposerCommands,
    uri: vscode.Uri,
    diagnostics: ReadonlyArray<vscode.Diagnostic>,
  ) {
    const attachments = yield* (yield* Problems).forDiagnostics(uri, diagnostics);
    if (attachments.length) {
      yield* this.queueAndFocus(attachments);
    }
  });
}
