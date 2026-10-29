import { Effect } from "effect";
import * as vscode from "vscode";
import { beforeOf, beginTurn, BeforeDocuments, keep, refresh, restorable, restore, restorePlan, undo } from "../fileChanges";
import { t } from "../i18n";
import { thenable, type AppServices, type VscodeError } from "../runtime";
import { folderOf } from "../workspace";
import type { ChangesMessage } from "./protocol";
import type { Tab } from "./tabs";

/** The changed files are recounted at most this often while the agent writes. */
const CHANGES_DELAY_MS = 200;

/** What the review of changes needs from the chat view. */
export interface ChangesHost {
  postTab(tab: Tab, message: Record<string, unknown>): void;
  /** Saves the tabs (their checkpoints with them). */
  saveTabs(): void;
  run<E>(effect: Effect.Effect<void, E, AppServices>, tab: Tab): void;
  openFile(file: string, line: number | undefined): Effect.Effect<void, VscodeError>;
}

/** Asks before a change that can't be taken back; true to go ahead. */
export const confirm = Effect.fn("confirm")(function* (message: string, action: string) {
  const picked = yield* thenable(() => vscode.window.showWarningMessage(message, { modal: true }, action));
  return picked === action;
});

/** Checkpoints and the review of the files the agent changed, per tab. */
export class ChangeReview implements vscode.Disposable {
  private readonly beforeDocuments = new BeforeDocuments();

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

  /** Forgets the tab's checkpoints, when it starts over; the files stay as they are. */
  clear(tab: Tab): void {
    tab.changes.clear();
    this.host.saveTabs();
    this.post(tab);
  }

  /** Takes the checkpoint before a turn. Outside the workspace (e.g. in the home folder) there are none. */
  readonly beginTurn = Effect.fn("ChangeReview.beginTurn")(function* (this: ChangeReview, tab: Tab, turn: number, label: string) {
    if (folderOf(tab.cwd) === undefined) {
      return;
    }
    yield* beginTurn(tab.changes, tab.cwd, turn, label).pipe(Effect.catch((err) => this.disable(tab, err.message)));
    this.host.saveTabs();
  });

  /** Diff of the changes to `file` since the last review, else of the tool call's own texts. */
  readonly openDiff = Effect.fn("ChangeReview.openDiff")(function* (
    this: ChangeReview,
    tab: Tab,
    file: string,
    oldText: string | null | undefined,
    newText: string | undefined,
  ) {
    const before = yield* beforeOf(tab.changes, file);
    if (before !== undefined) {
      yield* this.beforeDocuments.open(file, before);
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

  /** The tab's checkpoints in a quick pick, newest first; also those of messages no longer shown (after a reload). */
  readonly pick = Effect.fn("ChangeReview.pick")(function* (this: ChangeReview, tab: Tab) {
    const format = new Intl.DateTimeFormat(vscode.env.language, { dateStyle: "short", timeStyle: "short" });
    const items = (yield* restorable(tab.changes)).map(({ checkpoint, files }) => ({
      label: checkpoint.label || t("chat.untitled"),
      description: format.format(checkpoint.at),
      detail: t("checkpoints.files", files),
      turn: checkpoint.turn,
    }));
    if (items.length === 0) {
      void vscode.window.showInformationMessage(t("checkpoints.none"));
      return;
    }
    const picked = yield* thenable(() => vscode.window.showQuickPick(items, { title: t("checkpoints.pickTitle") }));
    if (picked) {
      yield* this.restore(tab, picked.turn);
    }
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
    this.beforeDocuments.dispose();
  }
}
