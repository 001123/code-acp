import { Effect } from "effect";
import * as vscode from "vscode";
import { beforeOf, beginTurn, BeforeDocuments, hunksOf, keep, keepHunk, refresh, restore, restorePlan, undo, undoHunk } from "../fileChanges";
import { t } from "../i18n";
import { thenable, type AppServices, type VscodeError } from "../runtime";
import { readSettings } from "../settings";
import { folderOf } from "../workspace";
import type { ChangeHunk, ChangesMessage } from "./protocol";
import type { Tab } from "./tabs";

/** The changed files are recounted at most this often while the agent writes. */
const CHANGES_DELAY_MS = 200;

/** Commands of the lenses above a change, called with the tab's id, the file and the change. */
export const KEEP_HUNK_COMMAND = "codeAcp.keepHunk";
export const UNDO_HUNK_COMMAND = "codeAcp.undoHunk";

/** What the review of changes needs from the chat view. */
export interface ChangesHost {
  postTab(tab: Tab, message: Record<string, unknown>): void;
  /** Saves the tabs (their checkpoints with them). */
  saveTabs(): void;
  run<E>(effect: Effect.Effect<void, E, AppServices>, tab: Tab): void;
  openFile(file: string, line: number | undefined): Effect.Effect<void, VscodeError, AppServices>;
}

/** Asks before a change that can't be taken back; true to go ahead. */
export const confirm = Effect.fn("confirm")(function* (message: string, action: string) {
  const picked = yield* thenable(() => vscode.window.showWarningMessage(message, { modal: true }, action));
  return picked === action;
});

/** Checkpoints and the review of the files the agent changed, per tab. */
export class ChangeReview implements vscode.Disposable {
  private readonly beforeDocuments = new BeforeDocuments();
  private readonly lensesChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeLenses = this.lensesChanged.event;

  constructor(private readonly host: ChangesHost) {}

  /** Lists the tab's changed files again and sends them to the chat, batching requests in quick succession. */
  post(tab: Tab): void {
    clearTimeout(tab.changesTimer);
    tab.changesTimer = setTimeout(() => {
      tab.changesTimer = undefined;
      this.host.run(
        Effect.gen({ self: this }, function* () {
          yield* refresh(tab.changes).pipe(Effect.catch((err) => this.disable(tab, err.message)));
          const message: ChangesMessage = { files: tab.changes.files, turns: tab.changes.turns };
          this.host.postTab(tab, { type: "changes", ...message });
          this.refreshLenses();
        }),
        tab,
      );
    }, CHANGES_DELAY_MS);
  }

  /** Re-lists the changes of tabs that have some, e.g. after the webview reloaded or a file was saved. */
  postIfTracked(tab: Tab, file?: string): void {
    if (tab.changes.base !== undefined && (file === undefined || tab.changes.relative(file) !== undefined)) {
      this.post(tab);
    }
  }

  /** The editors ask for their lenses again: the changes, the active tab or the setting changed. */
  refreshLenses(): void {
    this.lensesChanged.fire();
  }

  /**
   * Keep and Undo above each change in `document`, for the tab shown in the chat. The diff editor only shows them with
   * `diffEditor.codeLens` on, and has no stable API for actions of its own: the changes bar offers them there.
   */
  readonly lenses = Effect.fn("ChangeReview.lenses")(function* (this: ChangeReview, tab: Tab, document: vscode.TextDocument) {
    if (!readSettings().showChanges) {
      return [];
    }
    const file = document.uri.fsPath;
    const hunks = yield* hunksOf(tab.changes, file, document.getText());
    return hunks.flatMap((hunk) => {
      const line = Math.min(hunk.newStart, document.lineCount - 1);
      const range = new vscode.Range(line, 0, line, 0);
      const args = [tab.id, file, hunk];
      return [
        new vscode.CodeLens(range, { title: t("changes.keepHunk"), command: KEEP_HUNK_COMMAND, arguments: args }),
        new vscode.CodeLens(range, { title: t("changes.undoHunk"), command: UNDO_HUNK_COMMAND, arguments: args }),
      ];
    });
  });

  /** Sends the changes in `file` to the chat; a file that can't be opened as text has none. */
  readonly postHunks = Effect.fn("ChangeReview.postHunks")(function* (this: ChangeReview, tab: Tab, file: string) {
    const hunks = yield* thenable(() => vscode.workspace.openTextDocument(vscode.Uri.file(file))).pipe(
      Effect.flatMap((document) => hunksOf(tab.changes, file, document.getText())),
      Effect.orElseSucceed((): ChangeHunk[] => []),
    );
    this.host.postTab(tab, { type: "hunks", path: file, hunks });
  });

  readonly keepHunk = Effect.fn("ChangeReview.keepHunk")(function* (this: ChangeReview, tab: Tab, file: string, hunk: ChangeHunk) {
    this.reviewed(tab, yield* keepHunk(tab.changes, file, hunk));
  });

  readonly undoHunk = Effect.fn("ChangeReview.undoHunk")(function* (this: ChangeReview, tab: Tab, file: string, hunk: ChangeHunk) {
    this.reviewed(tab, yield* undoHunk(tab.changes, file, hunk));
  });

  private reviewed(tab: Tab, done: boolean): void {
    if (!done) {
      void vscode.window.showInformationMessage(t("changes.hunkStale"));
    }
    this.host.saveTabs();
    this.post(tab);
  }

  /** Forgets the tab's checkpoints, when it starts over; the files stay as they are. */
  clear(tab: Tab): void {
    tab.changes.clear();
    tab.changes.messages = 0;
    this.host.saveTabs();
    this.post(tab);
  }

  /** Puts the checkpoints back on their messages after the session's history replayed with `turns`. */
  matchReplay(tab: Tab, turns: ReadonlyArray<number>): void {
    tab.changes.matchReplay(turns);
    this.host.saveTabs();
    this.post(tab);
  }

  /** Takes the checkpoint before a turn. Outside the workspace (e.g. in the home folder) there are none. */
  readonly beginTurn = Effect.fn("ChangeReview.beginTurn")(function* (this: ChangeReview, tab: Tab, turn: number, label: string) {
    const position = tab.changes.countMessage();
    if (folderOf(tab.cwd) === undefined) {
      this.host.saveTabs();
      return;
    }
    yield* beginTurn(tab.changes, tab.cwd, turn, label, position).pipe(Effect.catch((err) => this.disable(tab, err.message)));
    this.host.saveTabs();
  });

  /** Diff of the changes to `file` since the last review, else of the tool call's own texts. */
  readonly openDiff = Effect.fn("ChangeReview.openDiff")(function* (
    this: ChangeReview,
    tab: Tab,
    file: string,
    oldText: string | null | undefined,
    newText: string | undefined,
    line?: number,
  ) {
    const before = yield* beforeOf(tab.changes, file);
    if (before !== undefined) {
      yield* this.beforeDocuments.open(file, before, undefined, line);
    } else if (newText !== undefined) {
      yield* this.beforeDocuments.open(file, oldText ?? null, newText);
    } else {
      yield* this.host.openFile(file, undefined);
    }
  });

  readonly keep = Effect.fn("ChangeReview.keep")(function* (this: ChangeReview, tab: Tab, file: string | undefined) {
    yield* keep(tab.changes, file);
    this.host.saveTabs();
    this.post(tab);
  });

  readonly undo = Effect.fn("ChangeReview.undo")(function* (this: ChangeReview, tab: Tab, file: string | undefined) {
    if (file === undefined && !(yield* confirm(t("changes.undoAllConfirm", tab.changes.files.length), t("changes.undoAll")))) {
      return;
    }
    yield* undo(tab.changes, file);
    this.host.saveTabs();
    this.post(tab);
  });

  readonly restore = Effect.fn("ChangeReview.restore")(function* (this: ChangeReview, tab: Tab, turn: number) {
    if (tab.busy) {
      void vscode.window.showInformationMessage(t("changes.restoreBusy"));
      return;
    }
    const files = yield* restorePlan(tab.changes, turn);
    if (files.length === 0 || !(yield* confirm(t("changes.restoreConfirm", files.length), t("changes.restore")))) {
      return;
    }
    yield* restore(tab.changes, turn);
    this.host.saveTabs();
    this.post(tab);
  });

  /**
   * Before the conversation goes back to the user message of `turn`: when the files differ from its checkpoint,
   * asks whether to put them back too. False when the user cancelled.
   */
  readonly rewind = Effect.fn("ChangeReview.rewind")(function* (this: ChangeReview, tab: Tab, turn: number) {
    const files = yield* restorePlan(tab.changes, turn);
    if (files.length === 0) {
      return true;
    }
    const restoreFiles = t("chat.rewindRestore");
    const keepFiles = t("chat.rewindKeep");
    const picked = yield* thenable(() =>
      vscode.window.showWarningMessage(t("chat.rewindFiles", files.length), { modal: true }, restoreFiles, keepFiles),
    );
    if (picked === restoreFiles) {
      yield* restore(tab.changes, turn);
      this.host.saveTabs();
      this.post(tab);
    }
    return picked !== undefined;
  });

  /** Turns snapshots off for the tab after one failed (no git, a work tree too big), saying why once. */
  private disable(tab: Tab, reason: string): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      yield* Effect.logWarning(`[checkpoints] ${reason}`);
      if (!tab.changes.disabled) {
        tab.changes.disabled = reason;
        this.host.postTab(tab, { type: "error", text: t("checkpoints.unavailable", reason) });
      }
    });
  }

  dispose(): void {
    this.lensesChanged.dispose();
    this.beforeDocuments.dispose();
  }
}
