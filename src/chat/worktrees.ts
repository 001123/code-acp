import { Effect, Option, Schema } from "effect";
import * as path from "node:path";
import * as vscode from "vscode";
import type { AgentRequestError, AgentStartError } from "../acpClient";
import type { AcpTrace } from "../acpTrace";
import { ShadowGit } from "../checkpoints";
import { t, type MessageKey } from "../i18n";
import { thenable, type ExtensionCtx, type Output, type VscodeError } from "../runtime";
import { folderOf } from "../workspace";
import { intoWorktree, isManaged, Worktrees, type PlacedWorktree, type ProjectCommand, type TabWorktree, type WorktreeError } from "../worktrees";
import { confirm } from "./changes";
import type { Attachment } from "./protocol";
import type { Tab, TabList } from "./tabs";

/** Where the fingerprints of the project setup commands the user allowed are kept. */
const APPROVED_COMMANDS_KEY = "codeAcp.approvedWorktreeCommands";
const decodeApproved = Schema.decodeUnknownOption(Schema.Array(Schema.String));

/** What the tab's worktree becomes when the tab leaves it. */
type Fate = "keep" | "delete" | "cancel";

type Choice =
  | { readonly kind: "local" | "new" | "apply" | "window" | "terminal" | "delete" | "current" }
  | { readonly kind: "existing"; readonly placed: PlacedWorktree };

/** Where the tab goes: its base folder, a new worktree there, or a worktree that exists. */
type Target = { readonly kind: "local" | "new" } | { readonly kind: "existing"; readonly placed: PlacedWorktree };

/** What the worktrees of tabs need from the chat view. */
export interface WorktreesHost {
  globalState(): vscode.Memento;
  tabs(): TabList;
  postTab(tab: Tab, message: Record<string, unknown>): void;
  postTabs(): void;
  status(tab: Tab, key: MessageKey): void;
  confirmStartOver(tab: Tab): Effect.Effect<boolean, VscodeError>;
  startOver(tab: Tab, change: (tab: Tab) => void): Effect.Effect<void, AgentStartError | AgentRequestError, Output | ExtensionCtx | AcpTrace | Worktrees | ShadowGit>;
}

const nameOf = (worktree: TabWorktree) => worktree.branch ?? path.basename(worktree.root);

/** The git worktrees of chat tabs: choosing them, bringing their changes back and cleaning them up. */
export class TabWorktrees {
  constructor(private readonly host: WorktreesHost) {}

  /** Whether another open tab runs in the worktree too (a fork); it stays while one does. */
  private shared(tab: Tab, worktree: TabWorktree): boolean {
    return this.host.tabs().all.some((other) => other !== tab && other.worktree?.root === worktree.root);
  }

  /** Offers the worktrees the tab can run in, and what can be done with its own. */
  readonly pick = Effect.fn("TabWorktrees.pick")(function* (this: TabWorktrees, tab: Tab) {
    const worktrees = yield* Worktrees;
    const current = tab.worktree;
    const base = current?.base ?? folderOf(tab.cwd)?.path;
    if (base === undefined || !(yield* worktrees.isRepo(base))) {
      void vscode.window.showInformationMessage(t("worktree.noRepo"));
      return;
    }
    const baseName = path.basename(base);
    const others = yield* worktrees.list(base);
    type Item = vscode.QuickPickItem & { readonly choice?: Choice };
    const separator = (label: string): Item => ({ label, kind: vscode.QuickPickItemKind.Separator });
    const items: Item[] = [
      {
        label: `$(folder) ${t("worktree.local")}`,
        description: current ? baseName : `${baseName} · ${t("worktree.current")}`,
        choice: { kind: current ? "local" : "current" },
      },
      { label: `$(add) ${t("worktree.new")}`, description: t("worktree.newDesc"), choice: { kind: "new" } },
    ];
    if (others.length > 0) {
      items.push(separator(t("worktree.existing")));
      for (const placed of others) {
        const isCurrent = placed.worktree.root === current?.root;
        const user = this.host.tabs().all.find((other) => other !== tab && other.worktree?.root === placed.worktree.root);
        items.push({
          label: `$(git-branch) ${nameOf(placed.worktree)}`,
          description: isCurrent ? t("worktree.current") : placed.worktree.root,
          detail: user ? t("worktree.inUse", user.name ?? user.title ?? t("chat.newTab")) : undefined,
          choice: isCurrent ? { kind: "current" } : { kind: "existing", placed },
        });
      }
    }
    if (current) {
      items.push(
        separator(t("worktree.thisOne")),
        { label: `$(git-merge) ${t("worktree.apply", baseName)}`, description: t("worktree.applyDesc"), choice: { kind: "apply" } },
        { label: `$(empty-window) ${t("worktree.openWindow")}`, choice: { kind: "window" } },
        { label: `$(terminal) ${t("worktree.openTerminal")}`, choice: { kind: "terminal" } },
      );
      if (isManaged(current.root) && !this.shared(tab, current)) {
        items.push({ label: `$(trash) ${t("worktree.delete")}`, choice: { kind: "delete" } });
      }
    }
    const picked = yield* thenable(() =>
      vscode.window.showQuickPick(items, { title: t("worktree.pickTitle"), placeHolder: t("worktree.pickPlaceholder") }),
    );
    switch (picked?.choice?.kind) {
      case "local":
      case "new":
        yield* this.switchTo(tab, base, { kind: picked.choice.kind });
        return;
      case "existing":
        yield* this.switchTo(tab, base, picked.choice);
        return;
      case "apply":
        if (current) {
          yield* this.apply(tab, current);
        }
        return;
      case "window":
        if (current) {
          yield* thenable(() => vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(current.root), { forceNewWindow: true }));
        }
        return;
      case "terminal":
        if (current) {
          vscode.window.createTerminal({ name: nameOf(current), cwd: tab.cwd }).show();
        }
        return;
      case "delete":
        // The question is the same as when going back to the local checkout, but "keep" here means no change.
        if ((yield* this.askRelease(tab)) === "delete") {
          yield* this.switchTo(tab, base, { kind: "local" }, "delete");
        }
        return;
    }
  });

  /**
   * Moves the tab to `target`, starting over in a fresh session there. Its worktree goes as `fate` says, asking
   * the user when it isn't given.
   */
  private readonly switchTo = Effect.fn("TabWorktrees.switchTo")(function* (
    this: TabWorktrees,
    tab: Tab,
    base: string,
    target: Target,
    fate?: Fate,
  ) {
    if (!(yield* this.host.confirmStartOver(tab))) {
      return;
    }
    const left = tab.worktree;
    const leftCwd = tab.cwd;
    const release = fate ?? (yield* this.askRelease(tab));
    if (release === "cancel") {
      this.host.postTabs();
      return;
    }
    const worktrees = yield* Worktrees;
    let next: PlacedWorktree | undefined;
    let setupError: string | undefined;
    if (target.kind === "new") {
      this.host.status(tab, "worktree.creating");
      next = Option.getOrUndefined(
        yield* worktrees.create(base).pipe(
          // The tab stays in its session.
          Effect.tapError(() => Effect.sync(() => this.host.status(tab, "chat.ready"))),
        ),
      );
      if (next) {
        setupError = yield* this.setUp(tab, next.worktree);
      }
    } else if (target.kind === "existing") {
      next = target.placed;
    }
    yield* this.host.startOver(tab, (tab) => {
      tab.worktree = next?.worktree;
      tab.cwd = next?.cwd ?? base;
    });
    if (next) {
      this.announce(tab, next.worktree);
    }
    // Only now: starting over clears the transcript.
    this.reportSetup(tab, setupError);
    if (left && release === "delete") {
      yield* this.discard(left, leftCwd);
    }
  });

  private announce(tab: Tab, worktree: TabWorktree): void {
    this.host.postTab(tab, { type: "notice", key: "worktree.started", args: [nameOf(worktree)] });
  }

  /** Readies a new worktree, before the agent starts there; returns what went wrong, which doesn't stop the tab. */
  private readonly setUp = Effect.fn("TabWorktrees.setUp")(function* (this: TabWorktrees, tab: Tab, worktree: TabWorktree) {
    this.host.status(tab, "worktree.settingUp");
    return yield* (yield* Worktrees).setup(worktree, (request) => this.approve(worktree, request)).pipe(
      Effect.as(undefined),
      Effect.catch((err) => Effect.succeed(err.message)),
    );
  });

  /** Whether a project's setup command may run: asks the first time, and again once its fingerprint changes. */
  private readonly approve = Effect.fn("TabWorktrees.approve")(
    function* (this: TabWorktrees, worktree: TabWorktree, request: ProjectCommand) {
      const globalState = this.host.globalState();
      const approved = () => Option.getOrElse(decodeApproved(globalState.get(APPROVED_COMMANDS_KEY)), (): ReadonlyArray<string> => []);
      if (approved().includes(request.fingerprint)) {
        return true;
      }
      const allow = t("worktree.projectCommandAllow");
      const picked = yield* thenable(() =>
        vscode.window.showWarningMessage(
          t("worktree.projectCommandConfirm", path.basename(worktree.base)),
          { modal: true, detail: t("worktree.projectCommandDetail", request.command) },
          allow,
        ),
      );
      if (picked !== allow) {
        return false;
      }
      yield* thenable(() => globalState.update(APPROVED_COMMANDS_KEY, [...approved(), request.fingerprint]));
      return true;
    },
    // Not running it is the safe answer when the question or its answer fails.
    Effect.catch((err) => Effect.logWarning(`[worktrees] ${err.message}`).pipe(Effect.as(false))),
  );

  private reportSetup(tab: Tab, error: string | undefined): void {
    if (error !== undefined && this.host.tabs().has(tab)) {
      this.host.postTab(tab, { type: "error", text: error });
    }
  }

  /** Runs a tab that asked for it in a new worktree; it stays where it is when its folder isn't in git, or that fails. */
  readonly prepare = Effect.fn("TabWorktrees.prepare")(function* (this: TabWorktrees, tab: Tab) {
    if (!tab.wantsWorktree) {
      return;
    }
    tab.wantsWorktree = false;
    const base = folderOf(tab.cwd)?.path;
    if (base === undefined || tab.worktree) {
      return;
    }
    const worktrees = yield* Worktrees;
    if (!(yield* worktrees.isRepo(base))) {
      return;
    }
    this.host.status(tab, "worktree.creating");
    const created = yield* worktrees.create(base).pipe(
      Effect.catch((err) =>
        Effect.sync(() => {
          this.host.postTab(tab, { type: "error", text: err.message });
          return Option.none<PlacedWorktree>();
        }),
      ),
    );
    if (Option.isSome(created)) {
      tab.worktree = created.value.worktree;
      tab.cwd = created.value.cwd;
      this.host.postTabs();
      this.announce(tab, created.value.worktree);
      this.reportSetup(tab, yield* this.setUp(tab, created.value.worktree));
    }
  });

  /** Before the tab's session starts: brings its worktree back if it went missing, else returns the tab to its base folder. */
  readonly ensure = Effect.fn("TabWorktrees.ensure")(function* (this: TabWorktrees, tab: Tab) {
    const { worktree } = tab;
    if (!worktree) {
      return;
    }
    const worktrees = yield* Worktrees;
    const missing = !(yield* worktrees.exists(worktree.root));
    if (yield* worktrees.restore(worktree)) {
      if (missing) {
        // Git brought back only what it tracks.
        this.reportSetup(tab, yield* this.setUp(tab, worktree));
      }
      return;
    }
    tab.worktree = undefined;
    tab.cwd = worktree.base;
    // Its session and checkpoints were about the worktree.
    tab.reopen = undefined;
    tab.title = undefined;
    tab.createdAt = undefined;
    tab.used = false;
    tab.changes.clear();
    this.host.postTabs();
    this.host.postTab(tab, { type: "reset" });
    this.host.postTab(tab, { type: "notice", key: "worktree.missing" });
  });

  /**
   * What becomes of the tab's worktree when the tab leaves it. One with nothing to lose is deleted, one another tab
   * uses or the user made is kept; otherwise the user says, or cancels leaving.
   */
  readonly askRelease = Effect.fn("TabWorktrees.askRelease")(function* (this: TabWorktrees, tab: Tab) {
    const { worktree } = tab;
    if (!worktree || !isManaged(worktree.root) || this.shared(tab, worktree)) {
      return "keep" as Fate;
    }
    const worktrees = yield* Worktrees;
    if (!(yield* worktrees.exists(worktree.root))) {
      return "delete" as Fate;
    }
    const status = yield* worktrees.status(worktree).pipe(Effect.option);
    if (Option.isSome(status) && status.value.changed === 0 && status.value.commits === 0) {
      return "delete" as Fate;
    }
    const name = nameOf(worktree);
    const message = Option.isSome(status)
      ? t("worktree.deleteConfirm", name, status.value.changed, status.value.commits, path.basename(worktree.base))
      : t("worktree.deleteConfirmUnknown", name);
    const remove = t("worktree.deleteAction");
    const keep = t("worktree.keepAction");
    const picked = yield* thenable(() => vscode.window.showWarningMessage(message, { modal: true }, remove, keep));
    return (picked === remove ? "delete" : picked === keep ? "keep" : "cancel") as Fate;
  });

  /** Deletes a worktree no tab runs in any more, with its snapshots; a failure doesn't stop what the user was doing. */
  readonly discard = Effect.fn("TabWorktrees.discard")(function* (this: TabWorktrees, worktree: TabWorktree, cwd: string) {
    yield* (yield* Worktrees).remove(worktree).pipe(
      Effect.andThen(ShadowGit.use((shadow) => shadow.forget(cwd))),
      Effect.catch((err: WorktreeError) =>
        Effect.gen(function* () {
          yield* Effect.logWarning(`[worktrees] ${err.message}`);
          void vscode.window.showWarningMessage(t("worktree.removeFailed", nameOf(worktree), err.message));
        }),
      ),
    );
  });

  /** Deletes a worktree the tab has left, only if there is nothing in it to lose. */
  readonly discardIfEmpty = Effect.fn("TabWorktrees.discardIfEmpty")(function* (
    this: TabWorktrees,
    tab: Tab,
    worktree: TabWorktree,
    cwd: string,
  ) {
    if (!isManaged(worktree.root) || this.host.tabs().all.some((other) => other.worktree?.root === worktree.root)) {
      return;
    }
    const status = yield* (yield* Worktrees).status(worktree).pipe(Effect.option);
    if (Option.isSome(status) && status.value.changed === 0 && status.value.commits === 0) {
      yield* this.discard(worktree, cwd);
    }
  });

  /** Brings what the worktree holds into its base folder, and offers to delete it when that went cleanly. */
  private readonly apply = Effect.fn("TabWorktrees.apply")(function* (this: TabWorktrees, tab: Tab, worktree: TabWorktree) {
    const worktrees = yield* Worktrees;
    const name = nameOf(worktree);
    const baseName = path.basename(worktree.base);
    const status = yield* worktrees.status(worktree);
    if (status.changed === 0 && status.commits === 0) {
      void vscode.window.showInformationMessage(t("worktree.nothingToApply", name));
      return;
    }
    const message = t("worktree.applyConfirm", status.changed, status.commits, name, baseName);
    if (!(yield* confirm(message, t("worktree.applyAction")))) {
      return;
    }
    const applied = yield* worktrees.apply(worktree);
    if (!applied.applied) {
      void vscode.window.showInformationMessage(t("worktree.nothingToApply", name));
      return;
    }
    if (applied.conflicts.length > 0) {
      void vscode.window.showWarningMessage(t("worktree.appliedConflicts", name, baseName, applied.conflicts.join(", ")));
      return;
    }
    if (!isManaged(worktree.root) || this.shared(tab, worktree)) {
      void vscode.window.showInformationMessage(t("worktree.applied", name, baseName));
      return;
    }
    const remove = t("worktree.deleteAction");
    const picked = yield* thenable(() => vscode.window.showInformationMessage(t("worktree.applied", name, baseName), remove));
    // The tab may have moved on while the message was up.
    if (picked === remove && tab.worktree?.root === worktree.root && this.host.tabs().has(tab)) {
      yield* this.switchTo(tab, worktree.base, { kind: "local" }, "delete");
    }
  });

  /**
   * The attachment as the tab's agent should see it: files of the base folder are picked in the workspace, but the
   * agent must read and edit its worktree's copy. A file only the base folder has (ignored ones) stays there.
   */
  readonly localize = Effect.fn("TabWorktrees.localize")(function* <A extends Attachment>(this: TabWorktrees, tab: Tab, attachment: A) {
    if (!tab.worktree || (attachment.kind !== "uri" && attachment.kind !== "snippet")) {
      return attachment;
    }
    const uri = vscode.Uri.parse(attachment.uri);
    const mapped = uri.scheme === "file" ? intoWorktree(uri.fsPath, tab.worktree.base, tab.cwd) : undefined;
    if (mapped === undefined || !(yield* (yield* Worktrees).exists(mapped))) {
      return attachment;
    }
    return { ...attachment, uri: vscode.Uri.file(mapped).toString() };
  });
}
