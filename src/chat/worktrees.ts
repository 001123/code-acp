import { Deferred, Effect, type FileSystem, Option, Schema, Semaphore } from "effect";
import * as path from "node:path";
import * as vscode from "vscode";
import type { AgentRequestError, AgentStartError } from "../acpClient";
import type { AcpTrace } from "../acpTrace";
import { ShadowGit } from "../checkpoints";
import { t, type MessageKey } from "../i18n";
import { thenable, type ExtensionCtx, type Output, type VscodeError } from "../runtime";
import type { UsageLedger } from "../usageLedger";
import { folderOf, workspaceFolders } from "../workspace";
import { attemptBranchName, fallbackPrText, intoWorktree, isManaged, parsePrText, Worktrees, type PlacedWorktree, type ProjectCommand, type TabWorktree, type WorktreeError } from "../worktrees";
import { confirm } from "./changes";
import type { Attachment, PrDraft } from "./protocol";
import type { Tab, TabGroup, TabList } from "./tabs";

/** Where the fingerprints of the project setup commands the user allowed are kept. */
const APPROVED_COMMANDS_KEY = "codeAcp.approvedWorktreeCommands";
const decodeApproved = Schema.decodeUnknownOption(Schema.Array(Schema.String));

/** What the tab's worktree becomes when the tab leaves it. */
type Fate = "keep" | "delete" | "cancel";

/** The ways to finish the work in a worktree. */
type Finish = "merge" | "pr" | "apply" | "delete";

type Choice =
  | { readonly kind: "local" | "new" | "window" | "terminal" | "current" | "clean" | Finish }
  | { readonly kind: "existing"; readonly placed: PlacedWorktree };

type Item = vscode.QuickPickItem & { readonly choice?: Choice };

/** What the host holds of a tab's pull request while the user looks at its draft. */
interface OpenDraft {
  readonly worktree: TabWorktree;
  readonly remote: string;
  readonly base?: string;
  pending: boolean;
}

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
  /** Starts the session of an unused tab again, in the folder it moved to. */
  restartSession(tab: Tab): Effect.Effect<void, AgentStartError | AgentRequestError, Output | ExtensionCtx | AcpTrace | Worktrees | ShadowGit>;
  /** Runs a turn on the tab's agent; its last message, or undefined when there is none to use. */
  ask(tab: Tab, text: string): Effect.Effect<string | undefined, never, Output | ExtensionCtx | AcpTrace | Worktrees | ShadowGit | FileSystem.FileSystem | UsageLedger>;
}

const nameOf = (worktree: TabWorktree) => worktree.branch ?? path.basename(worktree.root);

/** Runs `effect` under a notification saying what is going on. */
const withProgress = <A, E, R>(title: string, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const done = yield* Deferred.make<void>();
    const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
    void vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, () => runPromise(Deferred.await(done)));
    return yield* effect.pipe(Effect.ensuring(Deferred.succeed(done, undefined)));
  });

/** Tells the user about a pull request, with a way to open it. */
const announcePr = (message: string, url: string) => {
  const open = t("worktree.prOpen");
  void vscode.window.showInformationMessage(message, open).then((picked) => {
    if (picked === open) {
      void vscode.env.openExternal(vscode.Uri.parse(url));
    }
  });
};

/** The git worktrees of chat tabs: choosing them, bringing their changes back and cleaning them up. */
export class TabWorktrees {
  /** Git is asked for one new worktree at a time: the tabs of a group ask at once. */
  private readonly creating = Semaphore.makeUnsafe(1);
  /** Per group: its tabs set up at once, and the project's command is one question for all of them. */
  private readonly groupApprovals = new WeakMap<TabGroup, { readonly lock: Semaphore.Semaphore; readonly answers: Map<string, boolean> }>();
  /** The pull requests whose draft the user is looking at. */
  private readonly drafts = new WeakMap<Tab, OpenDraft>();
  /** Tabs getting a pull request ready; another request in that time is dropped. */
  private readonly preparing = new WeakSet<Tab>();

  constructor(private readonly host: WorktreesHost) {}

  /** Whether another open tab runs in the worktree too (a fork); it stays while one does. */
  shared(tab: Tab, worktree: TabWorktree): boolean {
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
        ...(yield* this.finishItems(tab, current)),
        { label: `$(empty-window) ${t("worktree.openWindow")}`, choice: { kind: "window" } },
        { label: `$(terminal) ${t("worktree.openTerminal")}`, choice: { kind: "terminal" } },
      );
    }
    if (others.length > 0) {
      items.push(separator(""), { label: `$(clear-all) ${t("worktree.clean")}`, choice: { kind: "clean" } });
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
      case "merge":
      case "pr":
      case "apply":
      case "delete":
        if (current) {
          yield* this.finishWith(tab, current, picked.choice.kind);
        }
        return;
      case "clean":
        yield* this.cleanUp();
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
    }
  });

  /** The ways to finish the work in the tab's worktree. */
  private readonly finishItems = Effect.fn("TabWorktrees.finishItems")(function* (this: TabWorktrees, tab: Tab, worktree: TabWorktree) {
    const baseName = path.basename(worktree.base);
    const target = (yield* (yield* Worktrees).branchOf(worktree.base)) ?? baseName;
    const items: Item[] = [
      ...(worktree.branch === undefined
        ? []
        : [
            { label: `$(git-merge) ${t("worktree.merge", target)}`, description: t("worktree.mergeDesc"), choice: { kind: "merge" } },
            { label: `$(git-pull-request) ${t("worktree.pr")}`, description: t("worktree.prDesc"), choice: { kind: "pr" } },
          ] satisfies Item[]),
      { label: `$(diff-added) ${t("worktree.apply", baseName)}`, description: t("worktree.applyDesc"), choice: { kind: "apply" } },
    ];
    if (isManaged(worktree.root) && !this.shared(tab, worktree)) {
      items.push({ label: `$(trash) ${t("worktree.delete")}`, choice: { kind: "delete" } });
    }
    return items;
  });

  /** Offers the ways to finish the work in the tab's worktree. */
  readonly finish = Effect.fn("TabWorktrees.finish")(function* (this: TabWorktrees, tab: Tab) {
    const { worktree } = tab;
    if (!worktree) {
      return;
    }
    const items = yield* this.finishItems(tab, worktree);
    const picked = yield* thenable(() => vscode.window.showQuickPick(items, { title: t("worktree.finishTitle", nameOf(worktree)) }));
    const kind = picked?.choice?.kind;
    if (kind === "merge" || kind === "pr" || kind === "apply" || kind === "delete") {
      yield* this.finishWith(tab, worktree, kind);
    }
  });

  private readonly finishWith = Effect.fn("TabWorktrees.finishWith")(function* (this: TabWorktrees, tab: Tab, worktree: TabWorktree, how: Finish) {
    switch (how) {
      case "merge":
        yield* this.merge(tab, worktree);
        return;
      case "pr":
        yield* this.openPr(tab, worktree);
        return;
      case "apply":
        yield* this.apply(tab, worktree);
        return;
      case "delete":
        // The question is the same as when going back to the local checkout, but "keep" here means no change.
        if ((yield* this.askRelease(tab)) === "delete") {
          yield* this.switchTo(tab, worktree.base, { kind: "local" }, "delete");
        }
        return;
    }
  });

  /** Whether an agent is at work in the worktree; finishing would take what it has so far. */
  private isBusy(worktree: TabWorktree): boolean {
    const busy = this.host.tabs().all.some((tab) => tab.worktree?.root === worktree.root && (tab.busy || tab.sending));
    if (busy) {
      void vscode.window.showInformationMessage(t("worktree.finishBusy"));
    }
    return busy;
  }

  /** Reads whether the tab's worktree holds anything to finish, which shows the button for it. */
  readonly refreshFinishable = Effect.fn("TabWorktrees.refreshFinishable")(function* (this: TabWorktrees, tab: Tab) {
    const { worktree } = tab;
    if (!worktree || tab.busy) {
      return;
    }
    const status = yield* (yield* Worktrees).status(worktree).pipe(Effect.option);
    const finishable = Option.isSome(status) && (status.value.changed > 0 || status.value.commits > 0);
    // The tab may have moved on while git ran.
    if (tab.worktree?.root === worktree.root && tab.finishable !== finishable) {
      tab.finishable = finishable;
      this.host.postTabs();
    }
  });

  /** Asks for a commit message and commits what isn't committed yet; false when the user backs out. */
  private readonly commitPending = Effect.fn("TabWorktrees.commitPending")(function* (this: TabWorktrees, tab: Tab, worktree: TabWorktree, changed: number) {
    if (changed === 0) {
      return true;
    }
    const message = yield* thenable(() =>
      vscode.window.showInputBox({
        title: t("worktree.commitTitle", changed),
        prompt: t("worktree.commitPrompt"),
        value: tab.name ?? tab.title ?? "",
        ignoreFocusOut: true,
        validateInput: (value) => (value.trim() === "" ? t("worktree.commitEmpty") : undefined),
      }),
    );
    if (message === undefined) {
      return false;
    }
    yield* (yield* Worktrees).commit(worktree, message.trim());
    return true;
  });

  /** Merges the worktree's branch into its base folder, after asking, and offers to delete it when that went cleanly. */
  private readonly merge = Effect.fn("TabWorktrees.merge")(function* (this: TabWorktrees, tab: Tab, worktree: TabWorktree) {
    if (this.isBusy(worktree)) {
      return;
    }
    const worktrees = yield* Worktrees;
    const name = nameOf(worktree);
    const baseName = path.basename(worktree.base);
    const status = yield* worktrees.status(worktree);
    if (status.changed === 0 && status.commits === 0) {
      void vscode.window.showInformationMessage(t("worktree.nothingToFinish", name));
      return;
    }
    // Before anything is asked or committed: this is for the user to sort out, and no stash should hide their work.
    if (yield* worktrees.isBaseDirty(worktree)) {
      void vscode.window.showWarningMessage(t("worktree.baseDirty", baseName));
      return;
    }
    const target = (yield* worktrees.branchOf(worktree.base)) ?? baseName;
    if (!(yield* confirm(t("worktree.mergeConfirm", status.changed, status.commits, name, target), t("worktree.mergeAction")))) {
      return;
    }
    if (!(yield* this.commitPending(tab, worktree, status.changed))) {
      return;
    }
    const { conflicts } = yield* withProgress(t("worktree.merging"), worktrees.merge(worktree));
    this.host.postTabs();
    if (conflicts.length > 0) {
      const openChanges = t("worktree.openChanges");
      const abort = t("worktree.abortMerge");
      const picked = yield* thenable(() => vscode.window.showWarningMessage(t("worktree.mergeConflicts", name, target, conflicts.join(", ")), openChanges, abort));
      if (picked === openChanges) {
        yield* thenable(() => vscode.commands.executeCommand("workbench.view.scm"));
      } else if (picked === abort) {
        yield* worktrees.abortMerge(worktree);
      }
      return;
    }
    yield* this.offerDelete(tab, worktree, t("worktree.merged", name, target));
  });

  /** Gets a pull request of the worktree's branch ready; another request while one is on its way is dropped. */
  private readonly openPr = Effect.fn("TabWorktrees.openPr")(function* (this: TabWorktrees, tab: Tab, worktree: TabWorktree) {
    if (this.preparing.has(tab) || this.isBusy(worktree)) {
      return;
    }
    this.preparing.add(tab);
    yield* this.preparePr(tab, worktree).pipe(Effect.ensuring(Effect.sync(() => this.preparing.delete(tab))));
  });

  /** Updates the branch's open pull request, after asking; without one, has the agent write one for the user to look at. */
  private readonly preparePr = Effect.fn("TabWorktrees.preparePr")(function* (this: TabWorktrees, tab: Tab, worktree: TabWorktree) {
    const worktrees = yield* Worktrees;
    const name = nameOf(worktree);
    const target = yield* withProgress(t("worktree.prChecking"), worktrees.prTarget(worktree));
    const status = yield* worktrees.status(worktree);
    const { existing } = target;
    if (existing !== undefined) {
      if (
        !(yield* confirm(t("worktree.prUpdateConfirm", name, existing), t("worktree.prUpdateAction"))) ||
        !(yield* this.commitPending(tab, worktree, status.changed))
      ) {
        return;
      }
      yield* withProgress(t("worktree.prPushing"), worktrees.push(worktree, target.remote));
      this.host.postTabs();
      announcePr(t("worktree.prUpdated", existing), existing);
      return;
    }
    if (status.changed === 0 && status.commits === 0) {
      void vscode.window.showInformationMessage(t("worktree.nothingToFinish", name));
      return;
    }
    if (!(yield* this.commitPending(tab, worktree, status.changed))) {
      return;
    }
    const summary = yield* worktrees.prSummary(worktree);
    const reply = yield* this.host.ask(tab, t("worktree.prPrompt", summary.fork));
    // The tab may have moved on during the turn.
    if (!this.host.tabs().has(tab) || tab.worktree?.root !== worktree.root) {
      return;
    }
    const text = (reply === undefined ? undefined : parsePrText(reply)) ?? fallbackPrText(summary, tab.name ?? tab.title ?? name);
    this.drafts.set(tab, { worktree, remote: target.remote, ...(target.base === undefined ? {} : { base: target.base }), pending: false });
    const draft: PrDraft = { ...text, head: worktree.branch ?? name, remote: target.remote, ...(target.base === undefined ? {} : { base: target.base }) };
    this.host.postTabs();
    this.host.postTab(tab, { type: "prDraft", draft });
  });

  /** Pushes the branch and opens the pull request the user agreed to; the draft stays for another try when that fails. */
  readonly createPr = Effect.fn("TabWorktrees.createPr")(function* (this: TabWorktrees, tab: Tab, title: string, body: string) {
    const draft = this.drafts.get(tab);
    if (draft && tab.worktree?.root !== draft.worktree.root) {
      // The tab moved on without the draft's branch.
      this.clearDraft(tab);
      return;
    }
    if (!draft || draft.pending || title.trim() === "" || this.isBusy(draft.worktree)) {
      return;
    }
    const worktrees = yield* Worktrees;
    const setPending = (pending: boolean) =>
      Effect.sync(() => {
        draft.pending = pending;
        this.host.postTab(tab, { type: "prPending", pending });
      });
    yield* setPending(true);
    const url = yield* withProgress(
      t("worktree.prPushing"),
      worktrees.push(draft.worktree, draft.remote).pipe(Effect.andThen(worktrees.createPr(draft.worktree, { title: title.trim(), body }, draft.base))),
    ).pipe(Effect.ensuring(setPending(false)));
    this.clearDraft(tab);
    this.host.postTabs();
    announcePr(t("worktree.prCreated", url), url);
  });

  /** Drops the tab's draft of a pull request. */
  clearDraft(tab: Tab): void {
    if (this.drafts.delete(tab)) {
      this.host.postTab(tab, { type: "prDraft" });
    }
  }

  /** Offers to delete the worktrees the extension made that no open tab runs in; those with nothing to lose are picked. */
  readonly cleanUp = Effect.fn("TabWorktrees.cleanUp")(function* (this: TabWorktrees) {
    const worktrees = yield* Worktrees;
    const inUse = (root: string) => this.host.tabs().all.some((tab) => tab.worktree?.root === root);
    const folders = new Set([...workspaceFolders().map((folder) => folder.path), ...this.host.tabs().all.flatMap((tab) => (tab.worktree ? [tab.worktree.base] : []))]);
    const listed = yield* Effect.forEach([...folders], (folder) => worktrees.list(folder).pipe(Effect.orElseSucceed((): ReadonlyArray<PlacedWorktree> => [])));
    // Two folders of one repository list the same worktrees.
    const placed = [...new Map(listed.flat().map((each) => [each.worktree.root, each])).values()].filter(({ worktree }) => isManaged(worktree.root) && !inUse(worktree.root));
    if (placed.length === 0) {
      void vscode.window.showInformationMessage(t("worktree.cleanNone"));
      return;
    }
    const items = yield* Effect.forEach(placed, (each) =>
      worktrees.status(each.worktree).pipe(
        Effect.option,
        Effect.map((status) => {
          const empty = Option.isSome(status) && status.value.changed === 0 && status.value.commits === 0;
          const holds = Option.isNone(status)
            ? t("worktree.cleanUnknown")
            : empty
              ? t("worktree.cleanEmpty")
              : t("worktree.cleanHolds", status.value.changed, status.value.commits);
          return { label: `$(git-branch) ${nameOf(each.worktree)}`, description: holds, detail: each.worktree.root, picked: empty, each, empty };
        }),
      ),
    );
    const picked = yield* thenable(() => vscode.window.showQuickPick(items, { title: t("worktree.cleanTitle"), placeHolder: t("worktree.cleanPlaceholder"), canPickMany: true }));
    if (!picked || picked.length === 0) {
      return;
    }
    const risky = picked.filter((item) => !item.empty).length;
    if (risky > 0 && !(yield* confirm(t("worktree.cleanConfirm", picked.length, risky), t("worktree.cleanAction")))) {
      return;
    }
    let deleted = 0;
    for (const { each } of picked) {
      // A tab may have opened it while the question was up.
      if (inUse(each.worktree.root)) {
        continue;
      }
      yield* this.discard(each.worktree, each.cwd);
      deleted += (yield* worktrees.exists(each.worktree.root)) ? 0 : 1;
    }
    void vscode.window.showInformationMessage(t("worktree.cleaned", deleted));
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
    this.clearDraft(tab);
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
    return yield* (yield* Worktrees).setup(worktree, (request) => (tab.group ? this.approveOnce(tab.group, worktree, request) : this.approve(worktree, request))).pipe(
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

  /** Like `approve`, with a single question and answer for the tabs of `group`. */
  private approveOnce(group: TabGroup, worktree: TabWorktree, request: ProjectCommand) {
    let shared = this.groupApprovals.get(group);
    if (!shared) {
      this.groupApprovals.set(group, (shared = { lock: Semaphore.makeUnsafe(1), answers: new Map() }));
    }
    const { lock, answers } = shared;
    return Semaphore.withPermits(lock, 1)(
      Effect.gen({ self: this }, function* () {
        const known = answers.get(request.fingerprint);
        if (known !== undefined) {
          return known;
        }
        const answer = yield* this.approve(worktree, request);
        answers.set(request.fingerprint, answer);
        return answer;
      }),
    );
  }

  private reportSetup(tab: Tab, error: string | undefined): void {
    if (error !== undefined && this.host.tabs().has(tab)) {
      this.host.postTab(tab, { type: "error", text: error });
    }
  }

  /**
   * Runs a tab that asked for it in a new worktree; it stays where it is when its folder isn't in git, or that fails.
   * A tab of a group must not work in the base folder, where the others would see its changes: false until it has its
   * worktree, and it keeps asking.
   */
  readonly prepare = Effect.fn("TabWorktrees.prepare")(function* (this: TabWorktrees, tab: Tab) {
    if (!tab.wantsWorktree) {
      return true;
    }
    const required = tab.group !== undefined;
    tab.wantsWorktree = required;
    const refuse = (text: string) =>
      Effect.sync(() => {
        this.host.postTab(tab, { type: "error", text });
        return Option.none<PlacedWorktree>();
      });
    const base = folderOf(tab.cwd)?.path;
    if (tab.worktree) {
      tab.wantsWorktree = false;
      return true;
    }
    const worktrees = yield* Worktrees;
    if (base === undefined || !(yield* worktrees.isRepo(base))) {
      if (required) {
        yield* refuse(t("worktree.noRepo"));
      }
      return !required;
    }
    this.host.status(tab, "worktree.creating");
    // A comparison's prompt is known by now; any other tab's branch gets its name with the first prompt.
    const name = tab.group ? attemptBranchName(tab.group.prompt, tab.attemptLabel ?? tab.agentId ?? "") : undefined;
    const created = yield* Semaphore.withPermits(this.creating, 1)(worktrees.create(base, name)).pipe(Effect.catch((err) => refuse(err.message)));
    if (Option.isNone(created)) {
      return !required;
    }
    if (!this.host.tabs().has(tab)) {
      // Closed while git was at work: nothing else knows about this worktree.
      yield* this.discard(created.value.worktree, created.value.cwd);
      return false;
    }
    tab.wantsWorktree = false;
    tab.worktree = created.value.worktree;
    tab.cwd = created.value.cwd;
    this.host.postTabs();
    this.announce(tab, created.value.worktree);
    this.reportSetup(tab, yield* this.setUp(tab, created.value.worktree));
    return true;
  });

  /**
   * Names the worktree of a tab after its first prompt, before the agent gets it (it may run git in there). A folder
   * only one tab runs in follows, and its session with it; on failure the worktree just keeps its random name.
   */
  readonly nameAfter = Effect.fn("TabWorktrees.nameAfter")(function* (this: TabWorktrees, tab: Tab, text: string) {
    const { worktree } = tab;
    if (!worktree) {
      return;
    }
    const worktrees = yield* Worktrees;
    const named = yield* Semaphore.withPermits(this.creating, 1)(worktrees.nameAfter(worktree, text, !this.shared(tab, worktree))).pipe(
      Effect.catch((err) => Effect.logWarning(`[worktrees] ${err.message}`).pipe(Effect.as(worktree))),
    );
    if (named.branch === worktree.branch) {
      return;
    }
    // Forks run in it too, and deleting or restoring it goes by the branch.
    for (const other of this.host.tabs().all) {
      if (other.worktree?.root === worktree.root) {
        other.worktree = { ...other.worktree, branch: named.branch, root: named.root };
        other.branch = other.branch === worktree.branch ? named.branch : other.branch;
      }
    }
    if (named.root !== worktree.root) {
      tab.cwd = path.join(named.root, path.relative(worktree.root, tab.cwd));
      this.host.postTabs();
      yield* this.host.restartSession(tab);
    }
    this.host.postTabs();
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
    this.clearDraft(tab);
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

  /** Brings what the worktree holds into its base folder, after asking; true when that went cleanly. */
  readonly applyChanges = Effect.fn("TabWorktrees.applyChanges")(function* (this: TabWorktrees, worktree: TabWorktree) {
    const worktrees = yield* Worktrees;
    const name = nameOf(worktree);
    const baseName = path.basename(worktree.base);
    const status = yield* worktrees.status(worktree);
    if (status.changed === 0 && status.commits === 0) {
      void vscode.window.showInformationMessage(t("worktree.nothingToApply", name));
      return false;
    }
    const message = t("worktree.applyConfirm", status.changed, status.commits, name, baseName);
    if (!(yield* confirm(message, t("worktree.applyAction")))) {
      return false;
    }
    const applied = yield* worktrees.apply(worktree);
    if (!applied.applied) {
      void vscode.window.showInformationMessage(t("worktree.nothingToApply", name));
      return false;
    }
    if (applied.conflicts.length > 0) {
      void vscode.window.showWarningMessage(t("worktree.appliedConflicts", name, baseName, applied.conflicts.join(", ")));
      return false;
    }
    return true;
  });

  /** Brings what the worktree holds into its base folder, and offers to delete it when that went cleanly. */
  private readonly apply = Effect.fn("TabWorktrees.apply")(function* (this: TabWorktrees, tab: Tab, worktree: TabWorktree) {
    if (!(yield* this.applyChanges(worktree))) {
      return;
    }
    yield* this.offerDelete(tab, worktree, t("worktree.applied", nameOf(worktree), path.basename(worktree.base)));
  });

  /** Says the worktree's work has arrived, with a way to delete the worktree when that is possible. */
  private readonly offerDelete = Effect.fn("TabWorktrees.offerDelete")(function* (this: TabWorktrees, tab: Tab, worktree: TabWorktree, message: string) {
    if (!isManaged(worktree.root) || this.shared(tab, worktree)) {
      void vscode.window.showInformationMessage(message);
      return;
    }
    const remove = t("worktree.deleteAction");
    const picked = yield* thenable(() => vscode.window.showInformationMessage(message, remove));
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
