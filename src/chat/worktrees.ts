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
import {
  attemptBranchName,
  branchSlug,
  fallbackPrText,
  intoWorktree,
  isManaged,
  parsePrText,
  Worktrees,
  type PlacedWorktree,
  type ProjectCommand,
  type TabWorktree,
  type WorktreeError,
  type WorktreeSettled,
} from "../worktrees";
import { confirm } from "./changes";
import type { Attachment, PrDraft } from "./protocol";
import type { Tab, TabGroup, TabList } from "./tabs";

/** Where the fingerprints of the project setup commands the user allowed are kept. */
const APPROVED_COMMANDS_KEY = "kdCode.approvedWorktreeCommands";
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
type Target =
  | { readonly kind: "local" }
  | { readonly kind: "new"; readonly name?: string }
  | { readonly kind: "existing"; readonly placed: PlacedWorktree };

/** What the worktrees of tabs need from the chat view. */
export interface WorktreesHost {
  globalState(): vscode.Memento;
  tabs(): TabList;
  postTab(tab: Tab, message: Record<string, unknown>): void;
  postTabs(): void;
  status(tab: Tab, key: MessageKey): void;
  confirmStartOver(tab: Tab): Effect.Effect<boolean, VscodeError>;
  startOver(
    tab: Tab,
    change: (tab: Tab) => void,
  ): Effect.Effect<void, AgentStartError | AgentRequestError, Output | ExtensionCtx | AcpTrace | Worktrees | ShadowGit>;
  /** Starts the session of an unused tab again, in the folder it moved to. */
  restartSession(
    tab: Tab,
  ): Effect.Effect<void, AgentStartError | AgentRequestError, Output | ExtensionCtx | AcpTrace | Worktrees | ShadowGit>;
  /** Runs a turn on the tab's agent; its last message, or undefined when there is none to use. */
  ask(
    tab: Tab,
    text: string,
  ): Effect.Effect<
    string | undefined,
    never,
    Output | ExtensionCtx | AcpTrace | Worktrees | ShadowGit | FileSystem.FileSystem | UsageLedger
  >;
}

const nameOf = (worktree: TabWorktree) => worktree.branch ?? path.basename(worktree.root);

/** Runs `effect` under a notification saying what is going on. */
const withProgress = <A, E, R>(title: string, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const done = yield* Deferred.make<void>();
    const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
    void vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, () =>
      runPromise(Deferred.await(done)),
    );
    return yield* effect.pipe(Effect.ensuring(Deferred.succeed(done, undefined)));
  });

/** Warns about something to sort out in the base folder, with a way to get there. */
const warnWithSourceControl = (message: string) => {
  const open = t("worktree.openChanges");
  void vscode.window.showWarningMessage(message, open).then((picked) => {
    if (picked === open) {
      void vscode.commands.executeCommand("workbench.view.scm");
    }
  });
};

/** The git worktrees of chat tabs: choosing them, bringing their changes back and cleaning them up. */
export class TabWorktrees {
  /** Git is asked for one new worktree at a time: the tabs of a group ask at once. */
  private readonly creating = Semaphore.makeUnsafe(1);
  /** Per group: its tabs set up at once, and the project's command is one question for all of them. */
  private readonly groupApprovals = new WeakMap<
    TabGroup,
    { readonly lock: Semaphore.Semaphore; readonly answers: Map<string, boolean> }
  >();
  /** The pull requests whose draft the user is looking at. */
  private readonly drafts = new WeakMap<Tab, OpenDraft>();
  /** Tabs getting a pull request ready; another request in that time is dropped. */
  private readonly preparing = new WeakSet<Tab>();
  /** Per tab: the latest read of its worktree's state, which is the one that counts. */
  private readonly reads = new WeakMap<Tab, number>();

  constructor(private readonly host: WorktreesHost) {}

  /** Whether another open tab runs in the worktree too (a fork); it stays while one does. */
  shared(tab: Tab, worktree: TabWorktree): boolean {
    return this.host.tabs().all.some((other) => other !== tab && other.worktree?.root === worktree.root);
  }

  /** The folder the tab's worktrees fork off; undefined when it isn't in a git repository. */
  private readonly repoBase = Effect.fn("TabWorktrees.repoBase")(function* (this: TabWorktrees, tab: Tab) {
    const base = tab.worktree?.base ?? folderOf(tab.cwd)?.path;
    return base !== undefined && (yield* (yield* Worktrees).isRepo(base)) ? base : undefined;
  });

  /** The Worktree box notes that the tab's next message moves it to a new worktree. A tab already in one has no box: a click that was on its way when it got there is dropped. */
  toggle(tab: Tab): void {
    if (tab.worktree) {
      return;
    }
    tab.worktreeOnSend = !tab.worktreeOnSend;
    this.host.postTabs();
  }

  /**
   * Moves a tab with its Worktree box ticked to a new worktree named after `prompt`, for the message about to go; false
   * when it stays where it is, so the message goes back to the composer. Outside git there is no worktree to have, and
   * the message goes on. An unused tab keeps what was picked in its session; a used one starts over, after asking.
   */
  readonly enterOnSend = Effect.fn("TabWorktrees.enterOnSend")(function* (
    this: TabWorktrees,
    tab: Tab,
    prompt: string,
  ) {
    const base = yield* this.repoBase(tab);
    if (base === undefined) {
      tab.worktreeOnSend = false;
      this.host.postTabs();
      return true;
    }
    const name = branchSlug(prompt);
    if (tab.used || tab.busy) {
      yield* this.switchTo(tab, base, { kind: "new", name });
    } else {
      tab.wantsWorktree = true;
      tab.worktreeName = name;
      yield* this.host.restartSession(tab);
    }
    return tab.worktree !== undefined;
  });

  /** Offers the worktrees the tab can run in, and what can be done with its own. */
  readonly pick = Effect.fn("TabWorktrees.pick")(function* (this: TabWorktrees, tab: Tab) {
    const worktrees = yield* Worktrees;
    const current = tab.worktree;
    const base = yield* this.repoBase(tab);
    if (base === undefined) {
      void vscode.window.showInformationMessage(t("worktree.noRepo"));
      return;
    }
    const baseName = path.basename(base);
    const others = yield* worktrees.list(base);
    const separator = (label: string): Item => ({ label, kind: vscode.QuickPickItemKind.Separator });
    const items: Item[] = [
      ...(current
        ? [{ label: `$(arrow-left) ${t("worktree.back", baseName)}`, choice: { kind: "local" } } satisfies Item]
        : []),
      {
        label: `$(add) ${t("worktree.new")}`,
        description: t(current ? "worktree.newDesc" : "worktree.toggleOn"),
        choice: { kind: "new" },
      },
    ];
    if (others.length > 0) {
      items.push(separator(t("worktree.existing")));
      for (const placed of others) {
        const isCurrent = placed.worktree.root === current?.root;
        const user = this.host
          .tabs()
          .all.find((other) => other !== tab && other.worktree?.root === placed.worktree.root);
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
        { label: `$(empty-window) ${t("worktree.openWindow")}`, choice: { kind: "window" } },
        { label: `$(terminal) ${t("worktree.openTerminal")}`, choice: { kind: "terminal" } },
      );
      if (isManaged(current.root) && !this.shared(tab, current)) {
        items.push({ label: `$(trash) ${t("worktree.delete")}`, choice: { kind: "delete" } });
      }
    }
    if (others.length > 0) {
      items.push(separator(""), { label: `$(clear-all) ${t("worktree.clean")}`, choice: { kind: "clean" } });
    }
    const picked = yield* thenable(() =>
      vscode.window.showQuickPick(items, {
        title: t("worktree.pickTitle"),
        placeHolder: t("worktree.pickPlaceholder"),
      }),
    );
    switch (picked?.choice?.kind) {
      case "local":
        yield* this.switchTo(tab, base, { kind: "local" });
        return;
      case "new":
        // Outside a worktree this is the Worktree box: it waits for the message, whose words name the worktree.
        if (current) {
          yield* this.switchTo(tab, base, { kind: "new" });
        } else {
          tab.worktreeOnSend = true;
          this.host.postTabs();
        }
        return;
      case "existing":
        yield* this.switchTo(tab, base, picked.choice);
        return;
      case "clean":
        yield* this.cleanUp();
        return;
      case "window":
        if (current) {
          yield* thenable(() =>
            vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(current.root), {
              forceNewWindow: true,
            }),
          );
        }
        return;
      case "terminal":
        if (current) {
          vscode.window.createTerminal({ name: nameOf(current), cwd: tab.cwd }).show();
        }
        return;
      case "delete":
        yield* this.deleteWorktree(tab);
        return;
    }
  });

  /** The ways to finish the work in the tab's worktree, and where a merge would go. */
  private readonly finishItems = Effect.fn("TabWorktrees.finishItems")(function* (
    this: TabWorktrees,
    tab: Tab,
    worktree: TabWorktree,
  ) {
    const worktrees = yield* Worktrees;
    const baseName = path.basename(worktree.base);
    const target = (yield* worktrees.branchOf(worktree.base)) ?? baseName;
    const baseDirty = worktree.branch !== undefined && (yield* worktrees.isBaseDirty(worktree));
    const hasPr = tab.settled?.how === "pr" && tab.settled.root === worktree.root;
    const items: Item[] = [
      ...(worktree.branch === undefined
        ? []
        : ([
            {
              label: `$(git-merge) ${t("worktree.merge", target)}`,
              description: baseDirty ? `$(warning) ${t("worktree.mergeBaseDirty", baseName)}` : t("worktree.mergeDesc"),
              choice: { kind: "merge" },
            },
            {
              label: `$(git-pull-request) ${t(hasPr ? "worktree.prPush" : "worktree.pr")}`,
              description: t(hasPr ? "worktree.prPushDesc" : "worktree.prDesc"),
              choice: { kind: "pr" },
            },
          ] satisfies Item[])),
      {
        label: `$(diff-added) ${t("worktree.apply", baseName)}`,
        description: t("worktree.applyDesc"),
        choice: { kind: "apply" },
      },
    ];
    if (isManaged(worktree.root) && !this.shared(tab, worktree)) {
      items.push({ label: `$(trash) ${t("worktree.delete")}`, choice: { kind: "delete" } });
    }
    return { items, target };
  });

  /** Offers the ways to finish the work in the tab's worktree, with what it holds and where that would go. */
  readonly finish = Effect.fn("TabWorktrees.finish")(function* (this: TabWorktrees, tab: Tab) {
    const { worktree } = tab;
    if (!worktree) {
      return;
    }
    const worktrees = yield* Worktrees;
    // The merge has to end first: the bar under the composer says how.
    if (yield* worktrees.isMerging(worktree)) {
      yield* this.refreshFinishable(tab);
      return;
    }
    const status = yield* worktrees.status(worktree);
    const { items, target } = yield* this.finishItems(tab, worktree);
    const picked = yield* thenable(() =>
      vscode.window.showQuickPick(items, {
        title: t("worktree.finishTitle", status.changed, status.commits, nameOf(worktree), target),
      }),
    );
    switch (picked?.choice?.kind) {
      case "merge":
        yield* this.merge(tab, worktree);
        return;
      case "pr":
        yield* this.preparePrOnce(tab, worktree);
        return;
      case "apply":
        yield* this.apply(tab, worktree);
        return;
      case "delete":
        yield* this.deleteWorktree(tab);
        return;
    }
  });

  /** Says where the work of the worktree went, for the tabs running in it; newer work starts over. */
  readonly settle = Effect.fn("TabWorktrees.settle")(function* (
    this: TabWorktrees,
    tab: Tab,
    worktree: TabWorktree,
    how: WorktreeSettled["how"],
    target: string,
  ) {
    const content = yield* (yield* Worktrees).contentId(worktree);
    const settled: WorktreeSettled = { how, root: worktree.root, target, content };
    for (const other of this.host.tabs().all) {
      if (other.worktree?.root === worktree.root) {
        other.settled = settled;
        other.conflict = undefined;
        other.finishable = false;
      }
    }
    this.reads.set(tab, (this.reads.get(tab) ?? 0) + 1);
    this.host.postTabs();
  });

  /** Where the work of the tab's worktree went, if the worktree still holds just that. */
  private readonly settledNow = Effect.fnUntraced(function* (this: TabWorktrees, tab: Tab, worktree: TabWorktree) {
    const { settled } = tab;
    if (settled?.root !== worktree.root) {
      return undefined;
    }
    const content = yield* (yield* Worktrees).contentId(worktree).pipe(Effect.option);
    return Option.isSome(content) && content.value === settled.content ? settled : undefined;
  });

  /**
   * Deletes the tab's worktree after one question, or none when an unused tab loses nothing, and takes the tab back to
   * its base folder. What it says is read now: the work may have gone on since the button showed.
   */
  readonly deleteWorktree = Effect.fn("TabWorktrees.deleteWorktree")(function* (this: TabWorktrees, tab: Tab) {
    const { worktree } = tab;
    if (!worktree || !isManaged(worktree.root) || this.shared(tab, worktree) || this.isBusy(worktree)) {
      return;
    }
    const name = nameOf(worktree);
    const status = yield* (yield* Worktrees).status(worktree).pipe(Effect.option);
    const safe =
      Option.isSome(status) &&
      ((status.value.changed === 0 && status.value.commits === 0) ||
        (yield* this.settledNow(tab, worktree)) !== undefined);
    const holds = Option.isNone(status)
      ? t("worktree.deleteConfirmUnknown", name)
      : safe
        ? t("worktree.deleteConfirmSafe", name)
        : t("worktree.deleteConfirm", name, status.value.changed, status.value.commits, path.basename(worktree.base));
    if (
      (!safe || tab.used) &&
      !(yield* confirm(`${holds} ${t("worktree.deleteClosesChat")}`, t("worktree.deleteAction")))
    ) {
      return;
    }
    // Asking took a while.
    if (tab.worktree?.root === worktree.root && this.host.tabs().has(tab) && !this.isBusy(worktree)) {
      yield* this.switchTo(tab, worktree.base, { kind: "local" }, "delete");
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

  /** Reads what state the tab's worktree is in, which decides what the bar under the composer offers. */
  readonly refreshFinishable = Effect.fn("TabWorktrees.refreshFinishable")(function* (this: TabWorktrees, tab: Tab) {
    const { worktree } = tab;
    if (!worktree) {
      tab.settled = undefined;
      tab.conflict = undefined;
      return;
    }
    if (tab.busy) {
      return;
    }
    const read = (this.reads.get(tab) ?? 0) + 1;
    this.reads.set(tab, read);
    const worktrees = yield* Worktrees;
    const status = yield* worktrees.status(worktree).pipe(Effect.option);
    const merging = yield* worktrees.isMerging(worktree).pipe(Effect.orElseSucceed(() => false));
    const target = merging ? ((yield* worktrees.branchOf(worktree.base)) ?? path.basename(worktree.base)) : undefined;
    const wasMerging = tab.conflict?.root === worktree.root ? tab.conflict.target : undefined;
    // It hashes what isn't committed: only when there is something to compare it with.
    const content =
      tab.settled?.root === worktree.root || wasMerging !== undefined
        ? yield* worktrees.contentId(worktree).pipe(Effect.option)
        : Option.none<string>();
    // The tab may have moved on while git ran, or something newer may have happened to it.
    if (tab.worktree?.root !== worktree.root || this.reads.get(tab) !== read) {
      return;
    }
    const hasWork = Option.isSome(status) && (status.value.changed > 0 || status.value.commits > 0);
    let settled = tab.settled?.root === worktree.root ? tab.settled : undefined;
    // The conflicts got solved and the merge committed, outside the chat.
    if (wasMerging !== undefined && !merging && !hasWork && Option.isSome(status) && Option.isSome(content)) {
      settled = { how: "merged", root: worktree.root, target: wasMerging, content: content.value };
    }
    const current = settled !== undefined && (Option.isNone(content) || content.value === settled.content);
    // A pull request takes newer work too; anything else was about the work that went.
    const kept = current || settled?.how === "pr" ? settled : undefined;
    const finishable = hasWork && !merging && !current;
    if (tab.finishable !== finishable || tab.settled !== kept || wasMerging !== target) {
      tab.finishable = finishable;
      tab.settled = kept;
      tab.conflict = target === undefined ? undefined : { root: worktree.root, target };
      this.host.postTabs();
    }
  });

  /** When the user comes back: the merge may be done in another window, and the pull request on its website. */
  readonly refreshOnFocus = Effect.fn("TabWorktrees.refreshOnFocus")(function* (this: TabWorktrees, tab: Tab) {
    yield* this.refreshFinishable(tab);
    const { worktree } = tab;
    if (!worktree || tab.busy || tab.settled?.how !== "pr" || (yield* this.settledNow(tab, worktree)) === undefined) {
      return;
    }
    const target = yield* (yield* Worktrees).prTarget(worktree).pipe(Effect.option);
    if (Option.isSome(target) && target.value.mergedAs !== undefined && tab.worktree?.root === worktree.root) {
      yield* this.settle(tab, worktree, "prMerged", target.value.mergedAs);
    }
  });

  /** Gives up the merge of the tab's worktree, after asking; solved conflicts go with it. */
  readonly abortMerge = Effect.fn("TabWorktrees.abortMerge")(function* (this: TabWorktrees, tab: Tab) {
    const { worktree } = tab;
    if (!worktree) {
      return;
    }
    const worktrees = yield* Worktrees;
    // The merge may have ended while the button showed.
    if (
      (yield* worktrees.isMerging(worktree)) &&
      (yield* confirm(t("worktree.abortConfirm"), t("worktree.abortMerge"))) &&
      (yield* worktrees.isMerging(worktree))
    ) {
      yield* worktrees.abortMerge(worktree);
    }
    yield* this.refreshFinishable(tab);
  });

  /** Opens the pull request the work of the tab's worktree went to. */
  openPr(tab: Tab): void {
    const { settled } = tab;
    if (settled?.how === "pr" || settled?.how === "prMerged") {
      void vscode.env.openExternal(vscode.Uri.parse(settled.target));
    }
  }

  /** Asks for a commit message and commits what isn't committed yet; false when the user backs out. */
  private readonly commitPending = Effect.fn("TabWorktrees.commitPending")(function* (
    this: TabWorktrees,
    tab: Tab,
    worktree: TabWorktree,
    changed: number,
  ) {
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

  /** Merges the worktree's branch into its base folder; the bar under the composer shows how that went. */
  private readonly merge = Effect.fn("TabWorktrees.merge")(function* (
    this: TabWorktrees,
    tab: Tab,
    worktree: TabWorktree,
  ) {
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
      warnWithSourceControl(t("worktree.baseDirty", baseName));
      return;
    }
    const target = (yield* worktrees.branchOf(worktree.base)) ?? baseName;
    if (!(yield* this.commitPending(tab, worktree, status.changed))) {
      return;
    }
    const { conflicts } = yield* withProgress(t("worktree.merging"), worktrees.merge(worktree));
    if (conflicts.length > 0) {
      for (const other of this.host.tabs().all) {
        if (other.worktree?.root === worktree.root) {
          other.conflict = { root: worktree.root, target };
          other.finishable = false;
        }
      }
      this.host.postTabs();
      void vscode.window.showWarningMessage(t("worktree.mergeConflicts", name, target, conflicts.join(", ")));
      return;
    }
    yield* this.settle(tab, worktree, "merged", target);
  });

  /** Gets a pull request of the worktree's branch ready; another request while one is on its way is dropped. */
  private readonly preparePrOnce = Effect.fn("TabWorktrees.preparePrOnce")(function* (
    this: TabWorktrees,
    tab: Tab,
    worktree: TabWorktree,
  ) {
    if (this.preparing.has(tab) || this.isBusy(worktree)) {
      return;
    }
    this.preparing.add(tab);
    yield* this.preparePr(tab, worktree).pipe(Effect.ensuring(Effect.sync(() => this.preparing.delete(tab))));
  });

  /** Updates the branch's open pull request, after asking; without one, has the agent write one for the user to look at. */
  private readonly preparePr = Effect.fn("TabWorktrees.preparePr")(function* (
    this: TabWorktrees,
    tab: Tab,
    worktree: TabWorktree,
  ) {
    const worktrees = yield* Worktrees;
    const name = nameOf(worktree);
    const target = yield* withProgress(t("worktree.prChecking"), worktrees.prTarget(worktree));
    const status = yield* worktrees.status(worktree);
    const { existing, mergedAs } = target;
    if (mergedAs !== undefined && status.changed === 0) {
      yield* this.settle(tab, worktree, "prMerged", mergedAs);
      return;
    }
    if (existing !== undefined) {
      if (target.pushed && status.changed === 0) {
        yield* this.settle(tab, worktree, "pr", existing);
        return;
      }
      if (
        !(yield* confirm(t("worktree.prUpdateConfirm", name, existing), t("worktree.prUpdateAction"))) ||
        !(yield* this.commitPending(tab, worktree, status.changed))
      ) {
        return;
      }
      yield* withProgress(t("worktree.prPushing"), worktrees.push(worktree, target.remote));
      yield* this.settle(tab, worktree, "pr", existing);
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
    const text =
      (reply === undefined ? undefined : parsePrText(reply)) ?? fallbackPrText(summary, tab.name ?? tab.title ?? name);
    this.drafts.set(tab, {
      worktree,
      remote: target.remote,
      ...(target.base === undefined ? {} : { base: target.base }),
      pending: false,
    });
    const draft: PrDraft = {
      ...text,
      head: worktree.branch ?? name,
      remote: target.remote,
      ...(target.base === undefined ? {} : { base: target.base }),
    };
    this.host.postTabs();
    this.host.postTab(tab, { type: "prDraft", draft });
  });

  /** Pushes the branch and opens the pull request the user agreed to; the draft stays for another try when that fails. */
  readonly createPr = Effect.fn("TabWorktrees.createPr")(function* (
    this: TabWorktrees,
    tab: Tab,
    title: string,
    body: string,
  ) {
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
      worktrees
        .push(draft.worktree, draft.remote)
        .pipe(Effect.andThen(worktrees.createPr(draft.worktree, { title: title.trim(), body }, draft.base))),
    ).pipe(Effect.ensuring(setPending(false)));
    this.clearDraft(tab);
    yield* this.settle(tab, draft.worktree, "pr", url);
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
    const folders = new Set([
      ...workspaceFolders().map((folder) => folder.path),
      ...this.host.tabs().all.flatMap((tab) => (tab.worktree ? [tab.worktree.base] : [])),
    ]);
    const listed = yield* Effect.forEach([...folders], (folder) =>
      worktrees.list(folder).pipe(Effect.orElseSucceed((): ReadonlyArray<PlacedWorktree> => [])),
    );
    // Two folders of one repository list the same worktrees.
    const placed = [...new Map(listed.flat().map((each) => [each.worktree.root, each])).values()].filter(
      ({ worktree }) => isManaged(worktree.root) && !inUse(worktree.root),
    );
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
          return {
            label: `$(git-branch) ${nameOf(each.worktree)}`,
            description: holds,
            detail: each.worktree.root,
            picked: empty,
            each,
            empty,
          };
        }),
      ),
    );
    const picked = yield* thenable(() =>
      vscode.window.showQuickPick(items, {
        title: t("worktree.cleanTitle"),
        placeHolder: t("worktree.cleanPlaceholder"),
        canPickMany: true,
      }),
    );
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
   * Moves the tab to `target`, starting over in a fresh session there. Its worktree goes as `fate` says; when that isn't
   * given, the user is asked about both.
   */
  private readonly switchTo = Effect.fn("TabWorktrees.switchTo")(function* (
    this: TabWorktrees,
    tab: Tab,
    base: string,
    target: Target,
    fate?: Fate,
  ) {
    if (fate === undefined && !(yield* this.host.confirmStartOver(tab))) {
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
        yield* worktrees.create(base, target.name).pipe(
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
      tab.worktreeOnSend = false;
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
  private readonly setUp = Effect.fn("TabWorktrees.setUp")(function* (
    this: TabWorktrees,
    tab: Tab,
    worktree: TabWorktree,
  ) {
    this.host.status(tab, "worktree.settingUp");
    return yield* (yield* Worktrees)
      .setup(worktree, (request) =>
        tab.group ? this.approveOnce(tab.group, worktree, request) : this.approve(worktree, request),
      )
      .pipe(
        Effect.as(undefined),
        Effect.catch((err) => Effect.succeed(err.message)),
      );
  });

  /** Whether a project's setup command may run: asks the first time, and again once its fingerprint changes. */
  private readonly approve = Effect.fn("TabWorktrees.approve")(
    function* (this: TabWorktrees, worktree: TabWorktree, request: ProjectCommand) {
      const globalState = this.host.globalState();
      const approved = () =>
        Option.getOrElse(decodeApproved(globalState.get(APPROVED_COMMANDS_KEY)), (): ReadonlyArray<string> => []);
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
    return Semaphore.withPermits(
      lock,
      1,
    )(
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
    // A comparison's prompt is known by now, and so is that of a tab moving for its message; any other tab's branch gets its name with the first prompt.
    const name = tab.group
      ? attemptBranchName(tab.group.prompt, tab.attemptLabel ?? tab.agentId ?? "")
      : tab.worktreeName;
    tab.worktreeName = undefined;
    const created = yield* Semaphore.withPermits(
      this.creating,
      1,
    )(worktrees.create(base, name)).pipe(Effect.catch((err) => refuse(err.message)));
    if (Option.isNone(created)) {
      return !required;
    }
    if (!this.host.tabs().has(tab)) {
      // Closed while git was at work: nothing else knows about this worktree.
      yield* this.discard(created.value.worktree, created.value.cwd);
      return false;
    }
    tab.wantsWorktree = false;
    tab.worktreeOnSend = false;
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
    const named = yield* Semaphore.withPermits(
      this.creating,
      1,
    )(worktrees.nameAfter(worktree, text, !this.shared(tab, worktree))).pipe(
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
    const settled = yield* this.settledNow(tab, worktree);
    // Merged or applied, it is all in the base folder; a pull request still under review may want this worktree again.
    if (settled !== undefined && settled.how !== "pr") {
      return "delete" as Fate;
    }
    const name = nameOf(worktree);
    const message =
      settled !== undefined
        ? t("worktree.deleteConfirmPr", name, settled.target)
        : Option.isSome(status)
          ? t("worktree.deleteConfirm", name, status.value.changed, status.value.commits, path.basename(worktree.base))
          : t("worktree.deleteConfirmUnknown", name);
    const remove = t("worktree.deleteAction");
    const keep = t("worktree.keepAction");
    const picked = yield* thenable(() => vscode.window.showWarningMessage(message, { modal: true }, remove, keep));
    return (picked === remove ? "delete" : picked === keep ? "keep" : "cancel") as Fate;
  });

  /** Deletes a worktree no tab runs in any more, with its snapshots; a failure doesn't stop what the user was doing. */
  readonly discard = Effect.fn("TabWorktrees.discard")(function* (
    this: TabWorktrees,
    worktree: TabWorktree,
    cwd: string,
  ) {
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

  /** Brings what the worktree holds into its base folder; true when that went cleanly. */
  private readonly bringOver = Effect.fn("TabWorktrees.bringOver")(function* (
    this: TabWorktrees,
    worktree: TabWorktree,
  ) {
    const name = nameOf(worktree);
    const applied = yield* (yield* Worktrees).apply(worktree);
    if (!applied.applied) {
      void vscode.window.showInformationMessage(t("worktree.nothingToApply", name));
      return false;
    }
    if (applied.conflicts.length > 0) {
      warnWithSourceControl(
        t("worktree.appliedConflicts", name, path.basename(worktree.base), applied.conflicts.join(", ")),
      );
      return false;
    }
    return true;
  });

  /** Brings what the worktree holds into its base folder, after asking; true when that went cleanly. */
  readonly applyChanges = Effect.fn("TabWorktrees.applyChanges")(function* (this: TabWorktrees, worktree: TabWorktree) {
    const name = nameOf(worktree);
    const status = yield* (yield* Worktrees).status(worktree);
    if (status.changed === 0 && status.commits === 0) {
      void vscode.window.showInformationMessage(t("worktree.nothingToApply", name));
      return false;
    }
    const message = t("worktree.applyConfirm", status.changed, status.commits, name, path.basename(worktree.base));
    return (yield* confirm(message, t("worktree.applyAction"))) && (yield* this.bringOver(worktree));
  });

  /** Brings what the worktree holds into its base folder; the bar under the composer shows how that went. */
  private readonly apply = Effect.fn("TabWorktrees.apply")(function* (
    this: TabWorktrees,
    tab: Tab,
    worktree: TabWorktree,
  ) {
    if (this.isBusy(worktree) || !(yield* this.bringOver(worktree))) {
      return;
    }
    yield* this.settle(tab, worktree, "applied", path.basename(worktree.base));
  });

  /**
   * The attachment as the tab's agent should see it: files of the base folder are picked in the workspace, but the
   * agent must read and edit its worktree's copy. A file only the base folder has (ignored ones) stays there.
   */
  readonly localize = Effect.fn("TabWorktrees.localize")(function* <A extends Attachment>(
    this: TabWorktrees,
    tab: Tab,
    attachment: A,
  ) {
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
