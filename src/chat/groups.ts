import { Effect, Exit } from "effect";
import * as path from "node:path";
import * as vscode from "vscode";
import type { AgentManager } from "../agentManager";
import { t } from "../i18n";
import { thenable } from "../runtime";
import { folderOf } from "../workspace";
import { Worktrees } from "../worktrees";
import type { ChangeReview } from "./changes";
import type { ChatUi } from "./host";
import type { AttemptPick, PromptPart, WorktreeDiff } from "./protocol";
import type { TabActions } from "./tabActions";
import { messageText, type Tab, type TabGroup, type TabList } from "./tabs";
import type { TabTurns } from "./turns";
import type { TabWorktrees } from "./worktrees";

const MAX_TITLE_LENGTH = 40;

/** Worktrees counted at the same time: each takes a git process that walks the whole tree. */
const DIFF_CONCURRENCY = 4;

/** What the groups of tabs need from the chat view. */
export interface GroupsHost extends ChatUi {
  readonly manager: AgentManager["Service"];
  readonly tabs: TabList;
  readonly turns: TabTurns;
  readonly changes: ChangeReview;
  readonly tabWorktrees: TabWorktrees;
  closeGroup(group: TabGroup, fate: "delete"): ReturnType<TabActions["closeGroup"]>;
}

/** Best of N: one prompt to several agents, each in a tab and worktree of its own, and what comes of comparing them. */
export class TabGroups {
  /** Per tab: the latest count asked for; an older one may finish after it. */
  private readonly diffRuns = new WeakMap<Tab, number>();

  constructor(private readonly host: GroupsHost) {}

  /** Sends the prompt to each of `attempts`; what `from` held goes back to its composer if there aren't two to compare. */
  readonly start = Effect.fn("TabGroups.start")(function* (this: TabGroups, from: Tab, parts: ReadonlyArray<PromptPart>, attempts: ReadonlyArray<AttemptPick>) {
    const giveBack = () => this.host.turns.loadComposer(from, { parts: [...parts] });
    const base = from.worktree?.base ?? folderOf(from.cwd)?.path;
    if (base === undefined || !(yield* (yield* Worktrees).isRepo(base))) {
      void vscode.window.showInformationMessage(t("worktree.noRepo"));
      return giveBack();
    }
    const agents = yield* this.host.manager.agents;
    const picked = attempts.filter(({ agentId }) => agents.some((agent) => agent.id === agentId));
    if (picked.length < 2) {
      void vscode.window.showInformationMessage(t("bestOf.pickTwo"));
      return giveBack();
    }
    const text = messageText(parts).trim();
    const firstLine = text.split("\n")[0] || t("chat.untitled");
    const title = firstLine.length > MAX_TITLE_LENGTH ? `${firstLine.slice(0, MAX_TITLE_LENGTH - 1)}…` : firstLine;
    const { tabs } = this.host;
    const group = tabs.addGroup(title, text);
    // All at once, so that nothing comes between them.
    const members = picked.map(({ agentId, model, effort, label }) => {
      const tab = tabs.add(base);
      tab.group = group;
      tab.agentId = agentId;
      tab.wanted = { model, effort };
      tab.attemptLabel = label;
      tab.attempt = "running";
      tab.wantsWorktree = true;
      // Not for another session to take over: its prompt is on the way.
      tab.used = true;
      return tab;
    });
    tabs.showGroup(group);
    this.host.postTabs();
    for (const tab of members) {
      this.host.run(this.runAttempt(tab, parts), tab);
    }
  });

  /** Sends the prompt in one tab of a group; its failure stays in that tab. */
  private runAttempt(tab: Tab, parts: ReadonlyArray<PromptPart>) {
    return this.host.turns.send(tab, { parts: [...parts] }).pipe(
      Effect.onExit((exit) =>
        Effect.sync(() => {
          // Without a session at the end, the agent wants the user first: to log in, say.
          tab.attempt = Exit.isSuccess(exit) && tab.sessionId !== undefined ? "done" : "failed";
          this.host.postTabs();
        }),
      ),
      Effect.ensuring(Effect.suspend(() => this.postDiff(tab))),
    );
  }

  /** A turn of the tab ended: it may be the one a failed attempt was waiting for, and files changed. */
  turnEnded(tab: Tab) {
    if (tab.group && tab.attempt === "failed" && tab.sessionId !== undefined) {
      tab.attempt = "done";
      this.host.postTabs();
    }
    return this.postDiff(tab);
  }

  /** Counts what the tab's worktree changed, for its group's comparison. */
  readonly postDiff = Effect.fn("TabGroups.postDiff")(function* (this: TabGroups, tab: Tab) {
    const { worktree } = tab;
    if (!tab.group || !worktree) {
      return;
    }
    const run = (this.diffRuns.get(tab) ?? 0) + 1;
    this.diffRuns.set(tab, run);
    const diff = yield* (yield* Worktrees).diff(worktree).pipe(
      Effect.map((files): WorktreeDiff => ({ files })),
      Effect.catch((err) => Effect.succeed<WorktreeDiff>({ files: [], error: err.message })),
    );
    if (this.diffRuns.get(tab) === run) {
      this.host.postTab(tab, { type: "worktreeDiff", diff });
    }
  });

  /** Counts what each of the group's tabs changed. */
  readonly postDiffs = Effect.fn("TabGroups.postDiffs")(function* (this: TabGroups, group: TabGroup) {
    yield* Effect.forEach(this.host.tabs.members(group), (tab) => this.postDiff(tab), { concurrency: DIFF_CONCURRENCY, discard: true });
  });

  readonly select = Effect.fn("TabGroups.select")(function* (this: TabGroups, group: TabGroup) {
    this.host.tabs.showGroup(group);
    this.host.postTabs();
    yield* this.postDiffs(group);
  });

  /** Opens what changed in `file` (from the top of the tab's worktree). */
  readonly openDiff = Effect.fn("TabGroups.openDiff")(function* (this: TabGroups, tab: Tab, file: string) {
    const { worktree } = tab;
    if (!worktree) {
      return;
    }
    const worktrees = yield* Worktrees;
    const full = path.join(worktree.root, file);
    const original = yield* worktrees.original(worktree, file);
    // A deleted file has no right side to open.
    yield* this.host.changes.openWorktreeDiff(full, original, (yield* worktrees.exists(full)) ? undefined : "");
  });

  /** Applies the tab's worktree to its base folder, and offers to close the group now that it is settled. */
  readonly apply = Effect.fn("TabGroups.apply")(function* (this: TabGroups, tab: Tab) {
    const { worktree, group } = tab;
    if (!worktree || !group) {
      return;
    }
    if (tab.busy) {
      void vscode.window.showInformationMessage(t("bestOf.applyBusy"));
      return;
    }
    if (!(yield* this.host.tabWorktrees.applyChanges(worktree))) {
      return;
    }
    tab.applied = true;
    this.host.postTabs();
    const close = t("bestOf.closeAndDelete");
    const name = worktree.branch ?? path.basename(worktree.root);
    const picked = yield* thenable(() => vscode.window.showInformationMessage(t("worktree.applied", name, path.basename(worktree.base)), close));
    if (picked === close) {
      yield* this.host.closeGroup(group, "delete");
    }
  });
}
