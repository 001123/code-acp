import { Effect, Option } from "effect";
import * as vscode from "vscode";
import type { AgentManager } from "../agentManager";
import { t } from "../i18n";
import { thenable, type VscodeError } from "../runtime";
import { readSettings } from "../settings";
import { cwdForNewTab } from "../workspace";
import { Worktrees } from "../worktrees";
import type { Attention } from "./attention";
import { confirm, type ChangeReview } from "./changes";
import type { Follower } from "./follow";
import type { Permissions } from "./permissions";
import type { TabSessions } from "./sessions";
import type { Tab, TabGroup, TabList } from "./tabs";
import type { TabWorktrees } from "./worktrees";

/** What the tab actions need from the chat view. */
export interface TabActionsHost {
  readonly manager: AgentManager["Service"];
  readonly tabs: TabList;
  readonly sessions: TabSessions;
  readonly tabWorktrees: TabWorktrees;
  readonly permissions: Permissions<Tab>;
  readonly attention: Attention<Tab>;
  readonly changes: ChangeReview;
  readonly follower: Follower;
  /** Shows the chat view. */
  readonly focus: Effect.Effect<unknown, VscodeError>;
  post(message: unknown): void;
  postTabs(): void;
}

/** A tab context menu action. */
export type TabAction = "pin" | "unpin" | "rename" | "close" | "closeOthers" | "closeToRight" | "fork" | "worktree";

/** What the user does to tabs as a whole: opening, selecting, closing and the context menu. */
export class TabActions {
  constructor(private readonly host: TabActionsHost) {}

  /** Opens a new tab with a fresh session, on `agentId` or else the default agent, in the active editor's folder or else the active tab's. */
  readonly newSession = Effect.fn("TabActions.newSession")(function* (this: TabActions, agentId?: string) {
    const { tabs, manager, sessions } = this.host;
    const tab = tabs.add(cwdForNewTab(tabs.length ? (tabs.active.worktree?.base ?? tabs.active.cwd) : undefined));
    tab.agentId = agentId ?? (yield* manager.activeId);
    tab.worktreeOnSend = readSettings().worktreeForNewTabs;
    tabs.active = tab;
    this.host.postTabs();
    yield* this.host.focus;
    this.host.post({ type: "focusComposer" });
    yield* sessions.ensureSession(tab);
  });

  readonly selectTab = Effect.fn("TabActions.selectTab")(function* (this: TabActions, tab: Tab) {
    this.host.tabs.active = tab;
    this.host.changes.refreshLenses();
    this.host.postTabs();
    if (!tab.busy) {
      yield* this.host.sessions.ensureSession(tab);
    }
  });

  /** Ends the tab's session and takes it off the list, its worktree going as `fate` says; where it was, or -1 if gone. */
  private readonly detach = Effect.fn("TabActions.detach")(function* (this: TabActions, tab: Tab, fate: "keep" | "delete") {
    const { tabs, sessions, tabWorktrees } = this.host;
    if (tab.busy) {
      yield* sessions.cancelTab(tab).pipe(Effect.ignore);
    }
    this.host.permissions.cancel(tab);
    this.host.follower.forget(tab);
    this.host.attention.clear(tab);
    const index = tabs.remove(tab);
    if (index < 0) {
      // Closed by another caller while its turn was being cancelled.
      return index;
    }
    clearTimeout(tab.changesTimer);
    if (tab.sessionId) {
      yield* sessions.closeSessionOnAgent(tab.running, tab.sessionId);
    }
    yield* sessions.stopIdleAgents;
    if (tab.worktree && fate === "delete" && !tabWorktrees.shared(tab, tab.worktree)) {
      yield* tabWorktrees.discard(tab.worktree, tab.cwd);
    }
    return index;
  });

  /** After tabs closed: another one takes over from the active tab if that went, near `index`, where it was. */
  private readonly settle = Effect.fn("TabActions.settle")(function* (this: TabActions, index: number) {
    const { tabs, sessions } = this.host;
    if (tabs.length === 0) {
      yield* this.newSession();
      return;
    }
    if (!tabs.has(tabs.active)) {
      tabs.active = tabs.at(Math.min(index, tabs.length - 1))!;
    }
    this.host.postTabs();
    yield* sessions.ensureSession(tabs.active);
  });

  readonly closeTab = Effect.fn("TabActions.closeTab")(function* (this: TabActions, tab: Tab) {
    const { tabs, tabWorktrees } = this.host;
    if (!tabs.has(tab)) {
      return;
    }
    const fate = yield* tabWorktrees.askRelease(tab);
    if (fate === "cancel") {
      return;
    }
    const index = yield* this.detach(tab, fate);
    if (index >= 0) {
      yield* this.settle(index);
    }
  });

  /**
   * Closes the tabs of a group. One question covers their worktrees, unless `fate` is given; applied ones have nothing
   * left to lose, and neither do those without changes.
   */
  readonly closeGroup = Effect.fn("TabActions.closeGroup")(function* (this: TabActions, group: TabGroup, fate?: "keep" | "delete") {
    const { tabs } = this.host;
    const members = tabs.members(group);
    if (members.length === 0) {
      return;
    }
    const decided = fate ?? (yield* this.askReleaseGroup(group));
    if (decided === "cancel") {
      return;
    }
    let index = tabs.indexOf(members[0]!);
    // Nothing else should start on the way out: a session for the tab that would become active next, say.
    for (const tab of members) {
      const at = yield* this.detach(tab, decided);
      if (at >= 0) {
        index = at;
      }
    }
    yield* this.settle(index);
  });

  /** Drops every attempt of the group, none being applied: asks first when an agent is still working or changes would go. */
  readonly discardGroup = Effect.fn("TabActions.discardGroup")(function* (this: TabActions, group: TabGroup) {
    const working = this.host.tabs.members(group).some((tab) => tab.busy || tab.attempt === "running");
    if ((working || (yield* this.holdingChanges(group)) > 0) && !(yield* confirm(t("bestOf.discardConfirm", group.name ?? group.title), t("bestOf.discardAction")))) {
      return;
    }
    yield* this.closeGroup(group, "delete");
  });

  /** How many of the group's worktrees would lose something if deleted. */
  private readonly holdingChanges = Effect.fn("TabActions.holdingChanges")(function* (this: TabActions, group: TabGroup) {
    const { tabs, tabWorktrees } = this.host;
    const worktrees = yield* Worktrees;
    let holding = 0;
    for (const tab of tabs.members(group)) {
      const { worktree } = tab;
      if (!worktree || tab.applied || tabWorktrees.shared(tab, worktree) || !(yield* worktrees.exists(worktree.root))) {
        continue;
      }
      const status = yield* worktrees.status(worktree).pipe(Effect.option);
      if (Option.isNone(status) || status.value.changed > 0 || status.value.commits > 0) {
        holding++;
      }
    }
    return holding;
  });

  private readonly askReleaseGroup = Effect.fn("TabActions.askReleaseGroup")(function* (this: TabActions, group: TabGroup) {
    const holding = yield* this.holdingChanges(group);
    if (holding === 0) {
      return "delete" as const;
    }
    const remove = t("bestOf.deleteWorktrees");
    const keep = t("bestOf.keepWorktrees");
    const picked = yield* thenable(() =>
      vscode.window.showWarningMessage(t("bestOf.closeConfirm", group.name ?? group.title, holding), { modal: true }, remove, keep),
    );
    return picked === remove ? ("delete" as const) : picked === keep ? ("keep" as const) : ("cancel" as const);
  });

  /** Runs a tab context menu action (webview context menu); pinned tabs are never closed. */
  readonly run = Effect.fn("TabActions.run")(function* (this: TabActions, id: number, action: TabAction) {
    const { tabs, sessions, tabWorktrees } = this.host;
    const tab = tabs.byId(id);
    if (!tab) {
      return;
    }
    switch (action) {
      case "pin":
      case "unpin":
        if (tabs.pin(tab, action === "pin")) {
          this.host.postTabs();
        }
        return;
      case "fork":
        yield* sessions.fork(tab, undefined);
        return;
      case "worktree":
        yield* tabWorktrees.pick(tab);
        return;
      case "rename":
        // Edited in place in the tab sidebar, which answers with "renameTab".
        this.host.post({ type: "renameTab", tab: tab.id });
        return;
      case "close":
        if (!tab.pinned) {
          yield* this.closeTab(tab);
        }
        return;
      case "closeOthers":
      case "closeToRight": {
        // A group counts as one: its tabs stay with `tab`, or close with one question.
        const siblings = tab.group ? tabs.members(tab.group) : [tab];
        const last = tabs.indexOf(siblings.at(-1)!);
        const targets = tabs.all.filter((each, i) => !each.pinned && !siblings.includes(each) && (action === "closeOthers" || i > last));
        if (targets.length && tabs.active !== tab && targets.includes(tabs.active)) {
          yield* this.selectTab(tab);
        }
        const groups = new Set(targets.flatMap((each) => (each.group ? [each.group] : [])));
        for (const each of targets) {
          if (!each.group) {
            yield* this.closeTab(each);
          }
        }
        for (const group of groups) {
          yield* this.closeGroup(group);
        }
        return;
      }
    }
  });

  /** Shows the chat with `tab` active. */
  readonly reveal = Effect.fn("TabActions.reveal")(function* (this: TabActions, tab: Tab) {
    if (!this.host.tabs.has(tab)) {
      return;
    }
    yield* this.host.focus;
    if (this.host.tabs.active !== tab || this.host.tabs.shownGroup) {
      yield* this.selectTab(tab);
    }
  });

  /**
   * Shows the tab that needs the user (status bar item): the first waiting for a permission or an answer, else one that finished
   * unseen, else a running one when the active tab is idle, else the active tab.
   */
  readonly showAttention = Effect.fn("TabActions.showAttention")(function* (this: TabActions) {
    const { tabs, permissions, attention } = this.host;
    const active = tabs.active;
    const tab = permissions.owners[0] ?? attention.owners("finished")[0] ?? (active.busy ? undefined : tabs.all.find((t) => t.busy)) ?? active;
    yield* this.reveal(tab);
  });
}
