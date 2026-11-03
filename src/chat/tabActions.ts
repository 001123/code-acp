import { Effect } from "effect";
import type { AgentManager } from "../agentManager";
import type { VscodeError } from "../runtime";
import { readSettings } from "../settings";
import { cwdForNewTab } from "../workspace";
import type { Attention } from "./attention";
import type { ChangeReview } from "./changes";
import type { Follower } from "./follow";
import type { Permissions } from "./permissions";
import type { TabSessions } from "./sessions";
import type { Tab, TabList } from "./tabs";
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

  /** Opens a new tab with a fresh session, in the active editor's folder or else the active tab's. */
  readonly newSession = Effect.fn("TabActions.newSession")(function* (this: TabActions) {
    const { tabs, manager, sessions } = this.host;
    const tab = tabs.add(cwdForNewTab(tabs.length ? (tabs.active.worktree?.base ?? tabs.active.cwd) : undefined));
    tab.agentId = yield* manager.activeId;
    tab.wantsWorktree = readSettings().worktreeForNewTabs;
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

  readonly closeTab = Effect.fn("TabActions.closeTab")(function* (this: TabActions, tab: Tab) {
    const { tabs, sessions, tabWorktrees } = this.host;
    if (!tabs.has(tab)) {
      return;
    }
    const fate = yield* tabWorktrees.askRelease(tab);
    if (fate === "cancel") {
      return;
    }
    if (tab.busy) {
      yield* sessions.cancelTab(tab).pipe(Effect.ignore);
    }
    this.host.permissions.cancel(tab);
    this.host.follower.forget(tab);
    this.host.attention.clear(tab);
    const index = tabs.remove(tab);
    if (index < 0) {
      // Closed by another caller while its turn was being cancelled.
      return;
    }
    clearTimeout(tab.changesTimer);
    if (tab.sessionId) {
      yield* sessions.closeSessionOnAgent(tab.running, tab.sessionId);
    }
    yield* sessions.stopIdleAgents;
    if (tab.worktree && fate === "delete") {
      yield* tabWorktrees.discard(tab.worktree, tab.cwd);
    }
    if (tabs.length === 0) {
      yield* this.newSession();
      return;
    }
    if (tabs.active === tab) {
      tabs.active = tabs.at(Math.min(index, tabs.length - 1))!;
    }
    this.host.postTabs();
    yield* sessions.ensureSession(tabs.active);
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
        const index = tabs.indexOf(tab);
        const targets = tabs.all.filter((each, i) => !each.pinned && (action === "closeOthers" ? each !== tab : i > index));
        if (targets.length && tabs.active !== tab && targets.includes(tabs.active)) {
          yield* this.selectTab(tab);
        }
        for (const each of targets) {
          yield* this.closeTab(each);
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
    if (this.host.tabs.active !== tab) {
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
