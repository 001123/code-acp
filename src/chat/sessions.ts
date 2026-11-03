import type * as acp from "@agentclientprotocol/sdk";
import { Effect, Schema, Semaphore } from "effect";
import * as vscode from "vscode";
import { canFork, type AgentRequestError, type AgentStartError, type AuthRequiredError } from "../acpClient";
import type { AcpTrace } from "../acpTrace";
import type { ShadowGit } from "../checkpoints";
import { ChangeSet } from "../fileChanges";
import { t } from "../i18n";
import { thenable, type ExtensionCtx, type Output } from "../runtime";
import { carryOptions, configureSession, modelOption, startingOptions, thoughtOption } from "../sessionOptions";
import { readSettings } from "../settings";
import { folderOf, defaultCwd, isWorkspaceFolder, workspaceFolders } from "../workspace";
import { Worktrees } from "../worktrees";
import type { AgentPool } from "./agents";
import { confirm, type ChangeReview } from "./changes";
import { canDeleteSessions, canReopen } from "./history";
import type { ChatUi } from "./host";
import type { LastOptions } from "./lastOptions";
import type { Permissions } from "./permissions";
import { resetConversation, type Reopen, type RunningAgent, type Tab, type TabList } from "./tabs";
import { TurnTraces } from "./turnTraces";
import type { TabTurns } from "./turns";
import type { TabUsage } from "./usage";
import type { TabWorktrees } from "./worktrees";

/** No agent installed or configured yet. */
export class NoAgentError extends Schema.TaggedError<NoAgentError>()("NoAgentError", {}) {}

/** What the sessions of tabs need from the chat view. */
export interface SessionsHost extends ChatUi {
  readonly tabs: TabList;
  readonly agents: AgentPool;
  readonly permissions: Permissions<Tab>;
  readonly lastOptions: LastOptions;
  readonly changes: ChangeReview;
  readonly usage: TabUsage;
  readonly tabWorktrees: TabWorktrees;
  readonly turns: TabTurns;
  selectTab(tab: Tab): Effect.Effect<void, AgentStartError | AgentRequestError, Output | ExtensionCtx | AcpTrace | Worktrees | ShadowGit>;
  /** The process of the agent `tab` runs on, started on first use. */
  getAgent(tab: Tab): Effect.Effect<RunningAgent, NoAgentError | AgentStartError | AuthRequiredError | AgentRequestError, Output | ExtensionCtx | AcpTrace>;
}

/** The ACP sessions of chat tabs: starting, reopening, forking and ending them. */
export class TabSessions {
  constructor(private readonly host: SessionsHost) {}

  private readonly createSession = Effect.fn("TabSessions.createSession")(function* (this: TabSessions, tab: Tab) {
    return yield* Semaphore.withPermits(
      tab.sessionLock,
      1,
    )(
      Effect.gen({ self: this }, function* () {
        if (tab.sessionId) {
          return tab.sessionId;
        }
        const running = yield* this.host.getAgent(tab);
        yield* this.host.tabWorktrees.ensure(tab);
        if (!(yield* this.host.tabWorktrees.prepare(tab))) {
          return undefined;
        }
        if (tab.reopen) {
          const reopened = yield* this.reopenSession(tab, running, tab.reopen);
          if (reopened) {
            return reopened;
          }
        }
        // A folder removed from the workspace, or the folder of a past session outside it: start in the workspace.
        if (!tab.worktree && folderOf(tab.cwd) === undefined) {
          tab.cwd = defaultCwd();
          this.host.postTabs();
        }
        const cwd = tab.cwd;
        const res = yield* running.agent.newSession(cwd);
        if (!this.host.tabs.has(tab) || tab.cwd !== cwd || tab.agentId !== running.agentId) {
          // Closed, or moved to another folder or agent, while the session was starting.
          yield* this.closeSessionOnAgent(running, res.sessionId);
          return res.sessionId;
        }
        tab.sessionId = res.sessionId;
        tab.traces.clear();
        tab.running = running;
        const configOptions = yield* this.restoreOptions(tab, running, res);
        this.host.setConfigOptions(tab, configOptions);
        this.host.postTabs();
        this.host.postTab(tab, { type: "session", sessionId: res.sessionId, configOptions });
        this.host.status(tab, "chat.ready");
        return res.sessionId;
      }),
    );
  });

  /** What sessions of the agent start with: chosen for it in settings, else last picked for it. */
  usualOptions(agentId: string) {
    const settings = readSettings();
    const remembered = settings.rememberSessionOptions ? this.host.lastOptions.wanted(agentId) : undefined;
    return startingOptions(settings.sessionDefaults[agentId], remembered);
  }

  /**
   * Sets the model, effort and fast mode a comparison picked for the tab, else those usual for the agent, on a session
   * just started or reopened (reopening gives the agent's defaults too), keeping the defaults for what it no longer
   * offers. Gives the session's options.
   */
  private restoreOptions(tab: Tab, running: RunningAgent, session: acp.NewSessionResponse) {
    const usual = this.usualOptions(running.agentId);
    const wanted = tab.wanted ? startingOptions(tab.wanted, usual) : usual;
    return wanted
      ? configureSession(running.agent, session, wanted).pipe(
          Effect.tapError((err) => Effect.logWarning(`Restoring the session options failed: ${err.message}`)),
          Effect.orElseSucceed(() => session.configOptions),
        )
      : Effect.succeed(session.configOptions);
  }

  /** Reopens a saved session in its tab; undefined when it can't be, and the tab should start over. */
  private readonly reopenSession = Effect.fn("TabSessions.reopenSession")(function* (
    this: TabSessions,
    tab: Tab,
    running: RunningAgent,
    reopen: Reopen,
  ) {
    if (canReopen(running.agent) && reopen.agentId === running.agentId) {
      const opened = yield* this.loadInto(tab, running, reopen.sessionId, reopen.cwd).pipe(
        Effect.as(true),
        // Auth errors keep `reopen`: the session can still be opened after logging in.
        Effect.catchTag("AgentRequestError", () =>
          Effect.sync(() => {
            this.host.postTab(tab, { type: "notice", key: "chat.reopenFailed" });
            // The reset before loading took it off the screen.
            this.host.turns.postQueue(tab);
            return false;
          }),
        ),
      );
      if (opened) {
        tab.reopen = undefined;
        this.host.saveTabs();
        return reopen.sessionId;
      }
    }
    tab.reopen = undefined;
    tab.title = undefined;
    tab.createdAt = undefined;
    tab.used = false;
    this.host.postTabs();
    return undefined;
  });

  /**
   * Shows a past session in `tab`, replaying its history when the agent supports session/load. The tab's checkpoints
   * stay: callers showing another session clear them first.
   */
  private readonly loadInto = Effect.fn("TabSessions.loadInto")(function* (
    this: TabSessions,
    tab: Tab,
    running: RunningAgent,
    sessionId: string,
    cwd: string,
  ) {
    const { agent } = running;
    const caps = agent.initializeResponse.agentCapabilities;
    this.host.postTab(tab, { type: "reset" });
    tab.sent.clear();
    const previousCwd = tab.cwd;
    // Set first: the replayed updates are only forwarded for a tab's session.
    tab.sessionId = sessionId;
    tab.running = running;
    tab.cwd = cwd;
    tab.used = true;
    tab.busy = true;
    this.host.status(tab, "chat.loadingSession");
    this.host.postTabs();
    const res = yield* (
      caps?.loadSession
        ? Effect.suspend(() => {
            const replaying = (tab.replaying = { blocks: [], turns: [] });
            return agent.loadSession(sessionId, cwd).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  const traces = tab.traces.matchReplay(replaying.turns);
                  if (traces.length > 0) {
                    this.host.postTab(tab, { type: "turnTraces", traces });
                  }
                  this.host.changes.matchReplay(tab, replaying.turns);
                }),
              ),
            );
          }).pipe(Effect.ensuring(Effect.sync(() => void (tab.replaying = undefined))))
        : agent.resumeSession(sessionId, cwd).pipe(
            Effect.tap(() => Effect.sync(() => this.host.postTab(tab, { type: "notice", key: "chat.resumedNoHistory" }))),
          )
    ).pipe(
      Effect.tapError(() =>
        Effect.sync(() => {
          tab.sessionId = undefined;
          tab.running = undefined;
          tab.cwd = previousCwd;
          this.host.postTabs();
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          tab.busy = false;
          this.host.refreshStatus(tab);
        }),
      ),
    );
    const configOptions = yield* this.restoreOptions(tab, running, { sessionId, configOptions: res.configOptions });
    this.host.setConfigOptions(tab, configOptions);
    this.host.postTab(tab, { type: "session", sessionId, configOptions });
    this.host.usage.postSaved(tab);
    this.host.status(tab, "chat.ready");
    // Messages sent while the session loaded.
    this.host.turns.sendQueued(tab);
  });

  /** The tab's session, created when missing; undefined when the user has to act first. */
  ensureSession(tab: Tab): Effect.Effect<string | undefined, AgentStartError | AgentRequestError, Output | ExtensionCtx | AcpTrace | Worktrees | ShadowGit> {
    return this.createSession(tab).pipe(
      Effect.catchTags({
        NoAgentError: () => Effect.sync(() => void this.host.status(tab, "chat.noAgent", { needsAgent: true })),
        AuthRequiredError: () => Effect.sync(() => void this.host.status(tab, "chat.needsLogin", { needsLogin: true })),
      }),
    );
  }

  /** Frees a session the chat no longer shows, when the agent supports session/close. */
  closeSessionOnAgent(running: RunningAgent | undefined, sessionId: string): Effect.Effect<void> {
    const agent = running?.agent;
    if (!agent?.initializeResponse.agentCapabilities?.sessionCapabilities?.close) {
      return Effect.void;
    }
    return agent.closeSession(sessionId).pipe(Effect.ignore);
  }

  /** Stops agent processes that no tab uses any more, nor is about to start a session on. */
  get stopIdleAgents(): Effect.Effect<void> {
    return this.host.agents.stopIdle((running) =>
      this.host.tabs.all.some((tab) => tab.running === running || (!tab.running && tab.agentId === running.agentId)),
    );
  }

  /** Ends the tab's conversation so it starts over in a fresh session, e.g. on another agent or in another folder. */
  readonly startOver = Effect.fn("TabSessions.startOver")(function* (this: TabSessions, tab: Tab, change: (tab: Tab) => void) {
    if (tab.busy) {
      yield* this.cancelTab(tab).pipe(Effect.ignore);
    }
    this.host.permissions.cancel(tab);
    if (tab.sessionId) {
      yield* this.closeSessionOnAgent(tab.running, tab.sessionId);
    }
    const queued = tab.queue;
    resetConversation(tab);
    tab.usage = undefined;
    tab.usageSessionId = undefined;
    change(tab);
    this.host.postTab(tab, { type: "reset" });
    // The user's to send or drop, wherever the tab went; the reset just emptied the webview's list.
    tab.queue = queued;
    if (queued.length > 0) {
      this.host.turns.postQueue(tab);
    }
    this.host.changes.clear(tab);
    this.host.postTabs();
    yield* this.stopIdleAgents;
    yield* this.ensureSession(tab);
  });

  /** Starts an unused tab's session again in its new folder, as a session can't change folders; what was picked in it stays. */
  readonly restartSession = Effect.fn("TabSessions.restartSession")(function* (this: TabSessions, tab: Tab) {
    const { running, sessionId, configOptions: picked } = tab;
    if (running && sessionId) {
      yield* this.closeSessionOnAgent(running, sessionId);
    }
    tab.sessionId = undefined;
    const restarted = yield* this.ensureSession(tab);
    if (restarted && tab.running) {
      const configOptions = yield* carryOptions(tab.running.agent, restarted, tab.configOptions, picked).pipe(
        Effect.tapError((err) => Effect.logWarning(`Keeping the session options failed: ${err.message}`)),
        Effect.orElseSucceed(() => tab.configOptions),
      );
      this.host.setConfigOptions(tab, configOptions);
      this.host.postTab(tab, { type: "configOptions", configOptions });
    }
  });

  /**
   * Asks before a start over ends a conversation (and stops a running turn); an unused tab has none to lose.
   * When the user says no, the pickers go back to the tab's agent and folder.
   */
  readonly confirmStartOver = Effect.fn("TabSessions.confirmStartOver")(function* (this: TabSessions, tab: Tab) {
    if (!tab.used && !tab.busy) {
      return true;
    }
    const ok = yield* confirm(t(tab.busy ? "chat.startOverBusyConfirm" : "chat.startOverConfirm"), t("chat.startOver"));
    if (!ok) {
      this.host.postTabs();
    }
    return ok && this.host.tabs.has(tab);
  });

  /** Moves `tab` to another workspace folder, starting over in a fresh session there. */
  readonly setTabCwd = Effect.fn("TabSessions.setTabCwd")(function* (this: TabSessions, tab: Tab, cwd: string) {
    if ((tab.worktree?.base ?? tab.cwd) === cwd || !isWorkspaceFolder(cwd) || !(yield* this.confirmStartOver(tab))) {
      return;
    }
    const left = tab.worktree;
    const leftCwd = tab.cwd;
    const fate = yield* this.host.tabWorktrees.askRelease(tab);
    if (fate === "cancel") {
      this.host.postTabs();
      return;
    }
    yield* this.startOver(tab, (tab) => {
      tab.cwd = cwd;
      tab.worktree = undefined;
      // A tab of a group may never work in the folder itself. Any other that had a worktree of its own, or would have had one, gets one in the new folder with its next message.
      tab.wantsWorktree = tab.group !== undefined;
      tab.worktreeOnSend = tab.group === undefined && (left !== undefined || tab.worktreeOnSend === true || readSettings().worktreeForNewTabs);
    });
    if (left && fate === "delete") {
      yield* this.host.tabWorktrees.discard(left, leftCwd);
    }
  });

  /**
   * Shows a past session: switches to its tab when it is open, else loads it into the active tab when that is
   * unused, else into a new tab. History is replayed when the agent supports session/load.
   */
  readonly openSession = Effect.fn("TabSessions.openSession")(function* (
    this: TabSessions,
    sessionId: string,
    cwd: string,
    title: string | undefined,
  ) {
    const open = this.host.tabs.showing(sessionId);
    if (open) {
      yield* this.host.selectTab(open);
      return;
    }
    // The history lists the active tab's agent's sessions.
    const from = this.host.tabs.active;
    const worktrees = yield* Worktrees;
    if (!(yield* worktrees.exists(cwd))) {
      this.host.postTab(from, { type: "notice", key: "worktree.folderGone" });
      return;
    }
    const running = yield* this.host.getAgent(from);
    const reuse = !from.used && !from.busy;
    const tab = reuse ? from : this.host.tabs.add(cwd);
    const replaced = tab.sessionId;
    const replacedOn = tab.running;
    const replacedWorktree = tab.worktree;
    const replacedCwd = tab.cwd;
    tab.worktree = yield* worktrees.locate(workspaceFolders().map((f) => f.path), cwd);
    tab.wantsWorktree = false;
    tab.worktreeOnSend = false;
    this.host.tabs.active = tab;
    tab.agentId = from.agentId;
    tab.title = title?.trim() || undefined;
    tab.createdAt = undefined;
    tab.reopen = undefined;
    this.host.postTabs();
    if (replaced) {
      yield* this.closeSessionOnAgent(replacedOn, replaced);
    }
    this.host.changes.clear(tab);
    tab.traces.clear();
    yield* this.loadInto(tab, running, sessionId, cwd).pipe(
      // Fall back to a fresh session so the tab stays usable.
      Effect.tapError(() =>
        Effect.suspend(() => {
          tab.worktree = replacedWorktree;
          return this.ensureSession(tab);
        }),
      ),
    );
    // The tab was unused, so a worktree it had holds nothing it needs.
    if (replacedWorktree && replacedWorktree.root !== tab.worktree?.root) {
      yield* this.host.tabWorktrees.discardIfEmpty(tab, replacedWorktree, replacedCwd);
    }
    this.host.saveTabs();
  });

  /**
   * Deletes a past session of the active tab's agent, after asking; tells whether it did. The session of an open tab
   * stays, so a conversation on screen can't vanish: the history only offers this for the others.
   */
  readonly deleteSession = Effect.fn("TabSessions.deleteSession")(function* (this: TabSessions, sessionId: string, title: string | undefined) {
    const { agent } = yield* this.host.getAgent(this.host.tabs.active);
    if (!canDeleteSessions(agent) || this.host.tabs.showing(sessionId)) {
      return false;
    }
    if (!(yield* confirm(t("chat.deleteSessionConfirm", title?.trim() || t("chat.untitled")), t("chat.deleteSession")))) {
      return false;
    }
    // The tab may have opened it while the question was up.
    if (this.host.tabs.showing(sessionId)) {
      return false;
    }
    yield* agent.deleteSession(sessionId);
    return true;
  });

  /**
   * Copies the conversation into a new tab next to `tab`, on a fork of its session (session/fork). With `turn`, the
   * fork goes back to before that user message, which waits in its composer.
   */
  readonly fork = Effect.fn("TabSessions.fork")(function* (this: TabSessions, tab: Tab, turn: number | undefined) {
    const { running, sessionId } = tab;
    if (!running || !sessionId || !canFork(running.agent)) {
      void vscode.window.showInformationMessage(t("chat.forkUnsupported"));
      return;
    }
    if (tab.busy || tab.sending) {
      void vscode.window.showInformationMessage(t("chat.forkBusy"));
      return;
    }
    const original = turn === undefined ? undefined : tab.sent.get(turn);
    if (turn !== undefined && !original) {
      this.host.postTab(tab, { type: "notice", key: "chat.cannotEdit" });
      return;
    }
    const res = yield* running.agent.forkSession(sessionId, tab.cwd);
    if (!this.host.tabs.has(tab) || !this.host.agents.isCurrent(running)) {
      // Closed, or its agent stopped, while forking.
      yield* this.closeSessionOnAgent(running, res.sessionId);
      return;
    }
    const fork = this.host.tabs.add(tab.cwd);
    fork.worktree = tab.worktree;
    this.host.tabs.move(fork, this.host.tabs.indexOf(tab) + 1);
    fork.agentId = running.agentId;
    fork.running = running;
    fork.sessionId = res.sessionId;
    fork.used = true;
    fork.title = t("chat.forkTitle", tab.name || tab.title || t("chat.untitled"));
    fork.createdAt = Date.now();
    fork.changes = ChangeSet.fromSaved(tab.changes.saved);
    fork.traces = TurnTraces.fromSaved(tab.traces.saved);
    fork.sent = new Map(tab.sent);
    fork.rewindNote = tab.rewindNote;
    if (tab.usage) {
      fork.usage = tab.usage;
      fork.usageSessionId = res.sessionId;
    }
    this.host.tabs.active = fork;
    this.host.postTabs();
    this.host.postTab(fork, { type: "forked", from: tab.id });
    this.host.setConfigOptions(fork, res.configOptions);
    this.host.postTab(fork, { type: "session", sessionId: res.sessionId, configOptions: res.configOptions });
    this.host.usage.postSaved(fork);
    this.host.changes.postIfTracked(fork);
    this.host.status(fork, "chat.ready");
    if (turn !== undefined && original) {
      this.host.turns.rewindTo(fork, turn);
      this.host.turns.loadComposer(fork, { parts: [...original.parts] });
    }
  });

  /** Sets a config option of the tab's session, remembering it for the agent's next sessions (codeAcp.rememberSessionOptions). */
  readonly setConfig = Effect.fn("TabSessions.setConfig")(function* (this: TabSessions, tab: Tab, configId: string, value: string) {
    if (!tab.running || !tab.sessionId) {
      return;
    }
    const { agentId } = tab.running;
    const before = tab.configOptions;
    const res = yield* tab.running.agent.setConfigOption(tab.sessionId, configId, value);
    const picked = readSettings().rememberSessionOptions ? this.host.lastOptions.picked(agentId, before, configId, value) : undefined;
    if (picked) {
      yield* thenable(() => picked);
    }
    if (tab.wanted) {
      // It reopens with what the user picked since.
      if (modelOption(before)?.id === configId) tab.wanted = { ...tab.wanted, model: value };
      else if (thoughtOption(before)?.id === configId) tab.wanted = { ...tab.wanted, effort: value };
    }
    this.host.setConfigOptions(tab, res.configOptions);
    this.host.postTab(tab, { type: "configOptions", configOptions: res.configOptions });
  });

  readonly cancelTab = Effect.fn("TabSessions.cancelTab")(function* (this: TabSessions, tab: Tab) {
    // ACP: the client must answer pending permission requests with "cancelled" on cancel.
    this.host.permissions.cancel(tab);
    if (tab.running && tab.sessionId) {
      yield* tab.running.agent.cancel(tab.sessionId);
    }
  });
}
