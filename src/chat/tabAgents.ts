import type * as acp from "@agentclientprotocol/sdk";
import { Effect, Exit, Option, Scope } from "effect";
import * as vscode from "vscode";
import { canLogout, spawnAgent, type UrlElicitation } from "../acpClient";
import type { AgentManager } from "../agentManager";
import type { AgentUpdate, AgentUpdates } from "../agentUpdates";
import { t } from "../i18n";
import { thenable, type AppRuntime } from "../runtime";
import { readSettings } from "../settings";
import { stopAll, type AgentPool } from "./agents";
import { AutoApprove } from "./autoApprove";
import { confirm, type ChangeReview } from "./changes";
import type { Follower } from "./follow";
import type { ChatUi } from "./host";
import { CANCELLED, ELICITATION_CANCELLED, parseElicitationUrl, type Permissions } from "./permissions";
import { canReopen } from "./history";
import { replayedParts } from "./replay";
import { NoAgentError, type TabSessions } from "./sessions";
import { detachSession, resetConversation, type RunningAgent, type Tab, type TabList } from "./tabs";
import type { TabTurns } from "./turns";
import type { TabUsage } from "./usage";

function isTerminalAuth(m: acp.AuthMethod): m is acp.AuthMethodTerminal & { type: "terminal" } {
  return "type" in m && m.type === "terminal";
}

/** What the agents of tabs need from the chat view. */
export interface AgentsHost extends ChatUi {
  readonly runtime: AppRuntime;
  readonly manager: AgentManager["Service"];
  readonly updates: AgentUpdates["Service"];
  readonly tabs: TabList;
  readonly agents: AgentPool;
  readonly permissions: Permissions<Tab>;
  readonly changes: ChangeReview;
  readonly usage: TabUsage;
  readonly follower: Follower;
  readonly turns: TabTurns;
  readonly sessions: TabSessions;
  post(message: unknown): void;
}

/** The agent processes behind chat tabs: picking, starting, logging in, updating and restarting them. */
export class TabAgents {
  constructor(private readonly host: AgentsHost) {}

  /** The composer's agent picker: installed and custom agents, their pending updates, and the default for new tabs. */
  get postAgent(): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const { manager, updates } = this.host;
      const activeId = yield* manager.activeId;
      const pending = new Map((yield* updates.pending).map((u) => [u.installed.id, u.latest.version]));
      const agents = (yield* manager.agents).map((a) => ({
        id: a.id,
        name: a.version ? `${a.name} ${a.version}` : a.name,
        icon: a.icon,
        update: pending.get(a.id),
      }));
      this.host.post({ type: "agent", agents, activeId });
    });
  }

  /** The agent `tab` runs on: its pick while it exists, else the default (last picked). */
  readonly agentIdOf = Effect.fn("TabAgents.agentIdOf")(function* (this: TabAgents, tab: Tab) {
    if (tab.agentId && (yield* this.host.manager.has(tab.agentId))) {
      return tab.agentId;
    }
    return yield* this.host.manager.activeId;
  });

  /** The process of the agent `tab` runs on, started on first use; the tab is set to that agent. */
  readonly getAgent = Effect.fn("TabAgents.getAgent")(function* (this: TabAgents, tab: Tab) {
    const agentId = yield* this.agentIdOf(tab);
    if (!agentId) {
      return yield* new NoAgentError();
    }
    if (tab.agentId !== agentId) {
      tab.agentId = agentId;
      this.host.postTabs();
    }
    return yield* this.host.agents.get(agentId, this.startAgent(agentId, tab));
  });

  private readonly startAgent = Effect.fn("TabAgents.startAgent")(function* (this: TabAgents, agentId: string, tab: Tab) {
    const command = yield* this.host.manager.command(agentId);
    if (!command) {
      return yield* new NoAgentError();
    }
    this.host.status(tab, "chat.starting");
    const scope = yield* Scope.make();
    // Set once spawned; the agent sends nothing before it answers `initialize`.
    let running: RunningAgent | undefined;
    const tabFor = (sessionId: string) => (running ? this.host.tabs.forSession(running, sessionId) : undefined);
    /** Each link the agent asked to open: `elicitation/complete` only names the link. */
    const links = new Map<string, { readonly tab: Tab; readonly finished: AbortController }>();
    const agent = yield* spawnAgent(command, {
      onUpdate: (n) => {
        const tab = tabFor(n.sessionId);
        if (tab) {
          this.onSessionUpdate(tab, n);
        }
      },
      requestPermission: (req, signal) => {
        const tab = tabFor(req.sessionId);
        // No tab: it was closed.
        if (!tab) {
          return Effect.succeed(CANCELLED);
        }
        const known = this.host.follower.known(tab, req.toolCall.toolCallId);
        const approval = AutoApprove.use((rules) => rules.approval(req, { cwd: tab.cwd, inWorktree: tab.worktree !== undefined, known }));
        return Effect.promise(() => this.host.runtime.runPromise(approval)).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => this.host.permissions.request(tab, req, signal),
              onSome: ({ optionId, title }) =>
                Effect.sync((): acp.RequestPermissionResponse => {
                  this.host.postTab(tab, { type: "notice", key: "chat.autoApproved", args: [title ?? "tool"] });
                  return { outcome: { outcome: "selected", optionId } };
                }),
            }),
          ),
        );
      },
      elicit: (req, signal) => {
        // A form needs a session to be about. A link can come without one, e.g. to sign in while a session starts.
        const tab = "sessionId" in req ? tabFor(req.sessionId) : req.mode === "url" ? this.host.tabs.active : undefined;
        if (!tab) {
          return Effect.succeed(ELICITATION_CANCELLED);
        }
        if (req.mode === "url") {
          const finished = new AbortController();
          links.set(req.elicitationId, { tab, finished });
          return this.elicitUrl(tab, req, AbortSignal.any([signal, finished.signal]));
        }
        return this.host.permissions.elicit(tab, req, signal);
      },
      onElicitationComplete: (elicitationId) => {
        const link = links.get(elicitationId);
        links.delete(elicitationId);
        if (link) {
          // Done without the user: they are no longer asked, and what the agent gets back says they didn't agree.
          link.finished.abort();
          this.host.postTab(link.tab, { type: "elicitationComplete", elicitationId });
        }
      },
      onTerminal: (snapshot) => {
        const tab = tabFor(snapshot.sessionId);
        if (tab) {
          this.host.postTab(tab, { type: "terminal", snapshot });
        }
      },
      onFileWritten: (sessionId, file) => {
        const tab = tabFor(sessionId);
        if (tab) {
          this.host.changes.post(tab);
          this.host.follower.fileWritten(tab, file);
        }
      },
    }).pipe(
      Scope.provide(scope),
      Effect.onError(() => Scope.close(scope, Exit.void)),
    );
    const started: RunningAgent = { agent, scope, agentId };
    running = started;
    // Interrupted when the scope closes, so only exits we did not cause are reported.
    yield* agent.exited.pipe(
      Effect.andThen(Effect.sync(() => this.onAgentExit(started))),
      Effect.forkIn(scope),
    );
    return started;
  });

  /**
   * Asks the user before opening a link the agent sent: an agent never opens one by itself, and one that isn't safe is
   * refused unseen. Accepting tells the agent the link was opened, not that what it is for is done.
   */
  private readonly elicitUrl = Effect.fn("TabAgents.elicitUrl")(function* (this: TabAgents, tab: Tab, request: UrlElicitation, signal: AbortSignal) {
    const url = Option.getOrUndefined(parseElicitationUrl(request.url, readSettings().allowedHttpHosts));
    if (!url) {
      this.host.postTab(tab, { type: "notice", key: "chat.elicitation.unsafeUrl", args: [request.url] });
      return { action: "decline" } satisfies acp.CreateElicitationResponse;
    }
    const { href } = url;
    const response = yield* this.host.permissions.elicit(tab, { ...request, url: href }, signal);
    if (response.action !== "accept") {
      return response;
    }
    // As a string, which VS Code opens as it is: a Uri decodes what is percent-encoded in the query, such as a
    // redirect address. The type only allows Uri.
    const opened = yield* thenable(() => vscode.env.openExternal(href as unknown as vscode.Uri)).pipe(
      Effect.tapError((err) => Effect.logWarning(`Opening a link failed: ${err.message}`)),
      Effect.orElseSucceed(() => false),
    );
    if (!opened) {
      this.host.postTab(tab, { type: "notice", key: "chat.elicitation.notOpened" });
      return ELICITATION_CANCELLED;
    }
    return { action: "accept" } satisfies acp.CreateElicitationResponse;
  });

  /** The turn a replayed user message chunk belongs to; each replayed message is kept to edit or send again. */
  private replayTurn(tab: Tab, update: acp.SessionUpdate): number | undefined {
    const replay = tab.replaying;
    if (!replay) return undefined;
    if (update.sessionUpdate !== "user_message_chunk") {
      replay.turn = undefined;
      replay.blocks = [];
      return undefined;
    }
    if (replay.turn === undefined) {
      replay.turn = this.host.turns.nextTurn();
      replay.turns.push(replay.turn);
    }
    replay.blocks.push(update.content);
    tab.sent.set(replay.turn, { parts: replayedParts(replay.blocks) });
    return replay.turn;
  }

  private onSessionUpdate(tab: Tab, n: acp.SessionNotification): void {
    const { update } = n;
    tab.turnStats?.onUpdate(update);
    if (tab.reply) {
      if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
        tab.reply.text += update.content.text;
      } else if (update.sessionUpdate === "tool_call") {
        tab.reply.text = "";
      }
    }
    if (update.sessionUpdate === "session_info_update" && update.title !== undefined) {
      tab.title = update.title ?? undefined;
      this.host.postTabs();
    }
    this.host.postTab(tab, { type: "update", update, turn: this.replayTurn(tab, update) });
    if (update.sessionUpdate === "config_option_update") {
      this.host.setConfigOptions(tab, update.configOptions);
    }
    if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      this.host.follower.toolCall(tab, update);
      // The tool may have changed files, however it did.
      if (update.status === "completed" || update.status === "failed") {
        this.host.changes.post(tab);
      }
    }
    if (update.sessionUpdate === "usage_update") {
      this.host.usage.onUpdate(tab, n.sessionId, update);
    }
  }

  private onAgentExit(running: RunningAgent): void {
    const { agents, tabs, permissions } = this.host;
    if (!agents.isCurrent(running)) {
      return;
    }
    agents.forget(running);
    for (const tab of tabs.all) {
      if (tab.running !== running) {
        continue;
      }
      permissions.cancel(tab);
      // The queue waits for the user rather than starting the agent again.
      detachSession(tab);
      this.host.status(tab, "chat.stopped", { stopped: true });
    }
    this.host.postTabs();
    // A separate fiber: this one runs inside the scope being closed.
    this.host.runtime.runFork(Scope.close(running.scope, Exit.void));
  }

  /** Switches `tab` to another agent, starting over in a fresh session; it also becomes the default for new tabs. */
  readonly setTabAgent = Effect.fn("TabAgents.setTabAgent")(function* (this: TabAgents, tab: Tab, agentId: string) {
    const { sessions } = this.host;
    const change = tab.agentId !== agentId;
    if (change && !(yield* sessions.confirmStartOver(tab))) {
      return;
    }
    yield* this.host.manager.setActive(agentId);
    if (change) {
      yield* sessions.startOver(tab, (tab) => (tab.agentId = agentId));
    }
  });

  readonly login = Effect.fn("TabAgents.login")(function* (this: TabAgents) {
    const { tabs, sessions, manager } = this.host;
    const running = yield* this.getAgent(tabs.active);
    const { agent } = running;
    const methods = agent.authMethods;
    if (methods.length === 0) {
      void vscode.window.showInformationMessage(t("chat.noAuthMethods"));
      return;
    }
    const picked =
      methods.length === 1
        ? methods[0]
        : (yield* thenable(() =>
            vscode.window.showQuickPick(
              methods.map((m) => ({ label: m.name, detail: m.description ?? undefined, method: m })),
              { title: t("chat.pickAuth") },
            ),
          ))?.method;
    if (!picked) {
      return;
    }

    if (isTerminalAuth(picked)) {
      // Terminal auth: run the agent binary itself with the method's args in a terminal.
      const cmd = yield* manager.command(running.agentId);
      if (!cmd) {
        return;
      }
      const terminal = vscode.window.createTerminal({
        name: "ACP Login",
        shellPath: cmd.command,
        shellArgs: [...cmd.args, ...(picked.args ?? [])],
        env: { ...cmd.env, ...(picked.env ?? {}) },
        cwd: tabs.active.cwd,
      });
      terminal.show();
      yield* Effect.callback<void>((resume) => {
        const sub = vscode.window.onDidCloseTerminal((closed) => {
          if (closed === terminal) {
            resume(Effect.void);
          }
        });
        return Effect.sync(() => sub.dispose());
      });
      // Restart so the agent picks up the new credentials.
      yield* this.restart(running.agentId);
    } else {
      yield* agent.authenticate(picked.id);
      yield* sessions.ensureSession(tabs.active);
    }
  });

  /**
   * Logs the active tab's agent out, after asking. Its process restarts, as sessions already running may stop working:
   * its tabs need a login next, and reopen their conversations after it when the agent can.
   */
  readonly logout = Effect.fn("TabAgents.logout")(function* (this: TabAgents) {
    const running = yield* this.getAgent(this.host.tabs.active);
    if (!canLogout(running.agent)) {
      void vscode.window.showInformationMessage(t("chat.logoutUnsupported"));
      return;
    }
    if (!(yield* confirm(t("chat.logoutConfirm"), t("chat.logout")))) {
      return;
    }
    yield* running.agent.logout;
    yield* this.restart(running.agentId);
  });

  /** Installs the agent's pending update, if it has one. */
  readonly updateAgent = Effect.fn("TabAgents.updateAgent")(function* (this: TabAgents, id: string) {
    const update = (yield* this.host.updates.pending).find((u) => u.installed.id === id);
    if (update) {
      yield* this.updateAgents([update]);
    }
  });

  /** Installs the updates, then offers to restart the updated agents that are running on the old version. */
  readonly updateAgents = Effect.fn("TabAgents.updateAgents")(function* (this: TabAgents, updates: ReadonlyArray<AgentUpdate>) {
    const updated = yield* this.host.updates.install(updates);
    if (!updated.length) {
      return;
    }
    const list = updated.map((agent) => `${agent.name} ${agent.version}`).join(", ");
    const running = updated.filter((agent) => this.host.agents.ids().includes(agent.id));
    if (!running.length) {
      void vscode.window.showInformationMessage(t("updates.done", list));
      return;
    }
    const restart = t("updates.restart");
    const picked = yield* thenable(() => vscode.window.showInformationMessage(t("updates.doneRestart", list), restart));
    if (picked === restart) {
      for (const agent of running) {
        yield* this.restart(agent.id);
      }
    }
  });

  /**
   * Restarts the agent `agentId`, or every agent. Their tabs get going again, the active one right away and the others
   * when selected: they reopen their conversations when the agent is still there and can, else they start over.
   */
  readonly restart = Effect.fn("TabAgents.restart")(function* (this: TabAgents, agentId?: string) {
    const { agents, tabs, permissions, changes, sessions, manager } = this.host;
    const stopped = agents.take(agentId);
    for (const tab of tabs.all) {
      const affected = tab.running
        ? stopped.includes(tab.running)
        : agentId === undefined || (tab.reopen?.agentId ?? tab.agentId) === agentId;
      if (!affected) {
        continue;
      }
      // Without a process to ask, reopening the session tells whether the agent can.
      const process = tab.running ?? stopped.find((running) => running.agentId === tab.reopen?.agentId);
      permissions.cancel(tab);
      // Its running turn is cut off, and no longer decides when the tab is idle.
      tab.turn = undefined;
      detachSession(tab);
      const owner = tab.reopen?.agentId;
      if (owner && (yield* manager.has(owner)) && (!process || canReopen(process.agent))) {
        changes.post(tab);
        this.host.status(tab, "chat.stopped", { stopped: true });
        continue;
      }
      resetConversation(tab);
      this.host.postTab(tab, { type: "reset" });
      // A tab in the background gets no session, and so no other status, until it is selected.
      this.host.refreshStatus(tab);
      changes.clear(tab);
    }
    this.host.postTabs();
    yield* stopAll(stopped);
    yield* sessions.ensureSession(tabs.active);
  });

  /** A removed agent's tabs move to the default agent. */
  readonly restartRemoved = Effect.fn("TabAgents.restartRemoved")(function* (this: TabAgents) {
    for (const id of this.host.agents.ids()) {
      if (!(yield* this.host.manager.has(id))) {
        yield* this.restart(id);
      }
    }
  });
}
