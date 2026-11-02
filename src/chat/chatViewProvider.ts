import type * as acp from "@agentclientprotocol/sdk";
import { Effect, Exit, Scope } from "effect";
import * as path from "node:path";
import * as vscode from "vscode";
import { spawnAgent } from "../acpClient";
import type { AgentManager } from "../agentManager";
import type { AgentUpdate, AgentUpdates } from "../agentUpdates";
import { onDidChangeLocale, t, webviewL10n, type MessageKey } from "../i18n";
import { runIn, thenable, type AppRuntime, type AppServices } from "../runtime";
import { choicesOf, modelOption, thoughtOption } from "../sessionOptions";
import { readSettings } from "../settings";
import { webviewHtml, webviewRoots } from "../webview";
import { Worktrees } from "../worktrees";
import { AgentPool, stopAll } from "./agents";
import { Attention, type AttentionReason } from "./attention";
import { AttachmentQueue, pruneTempFiles } from "./attachments";
import { ChangeReview, KEEP_HUNK_COMMAND, UNDO_HUNK_COMMAND } from "./changes";
import { ComposerCommands } from "./composerCommands";
import { DraftStore } from "./drafts";
import { LastOptions } from "./lastOptions";
import { Follower } from "./follow";
import { HistoryRequests, listHistory } from "./history";
import type { ChatUi } from "./host";
import { ViewMessages } from "./messages";
import { openFile } from "./openFile";
import { CANCELLED, ELICITATION_CANCELLED, Permissions } from "./permissions";
import { NoAgentError, TabSessions } from "./sessions";
import { ChatStatusBar } from "./statusBar";
import type { ChangeHunk, Draft, FromWebview, TabMessage } from "./protocol";
import { resetConversation, TabList, type RunningAgent, type Tab } from "./tabs";
import { replayedParts } from "./replay";
import { TabTurns } from "./turns";
import { TabUsage } from "./usage";
import { TabWorktrees } from "./worktrees";
import { cwdForNewTab, defaultCwd, workspaceFolders } from "../workspace";

const TABS_KEY = "codeAcp.tabs";

/** Tabs are written to workspaceState at most this often; usage updates arrive many times per turn. */
const SAVE_TABS_DELAY_MS = 500;

function isTerminalAuth(m: acp.AuthMethod): m is acp.AuthMethodTerminal & { type: "terminal" } {
  return "type" in m && m.type === "terminal";
}

/** The chat view: tabs of ACP sessions, each on the process of its agent. */
export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = "codeAcp.chat";
  /** Run by the status bar item: shows the tab that needs the user. */
  static readonly showAttentionCommand = "codeAcp.showAttention";

  private view?: vscode.WebviewView;
  private readonly agents = new AgentPool();
  private readonly tabs: TabList;
  private readonly drafts: DraftStore;
  private readonly lastOptions: LastOptions;
  private readonly turns: TabTurns;
  private readonly sessions: TabSessions;
  private readonly permissions = new Permissions<Tab>({
    shown: (tab, id, ask) => {
      this.view?.show(true);
      if (ask.kind === "permission") {
        const { toolCall, options } = ask.request;
        this.postTab(tab, { type: "permissionRequest", id, toolCall, options });
      } else {
        const { message, requestedSchema } = ask.request;
        const toolCallId = "toolCallId" in ask.request ? ask.request.toolCallId : undefined;
        this.postTab(tab, { type: "elicitationRequest", id, message, schema: requestedSchema, toolCallId });
      }
      this.attention.raise(tab, ask.kind === "permission" ? "permission" : "question");
      this.updateStatusBar();
    },
    done: (tab, id, answer) => {
      if (answer.kind === "permission") {
        this.postTab(tab, { type: "permissionDone", id });
      } else {
        this.postTab(tab, { type: "elicitationDone", id, action: answer.response.action });
      }
      this.attention.settle(tab, answer.kind === "permission" ? "permission" : "question");
      this.updateStatusBar();
    },
  });
  /** Tabs that finished or wait for a permission while the user looked elsewhere: the view's badge and notifications. */
  private readonly attention = new Attention<Tab>({
    sees: (tab) => vscode.window.state.focused && this.view?.visible === true && this.tabs.active === tab,
    badge: () => this.showBadge(),
    notify: (tab, reason) => this.notify(tab, reason),
  });
  private readonly changes = new ChangeReview({
    postTab: (tab, message) => this.postTab(tab, message),
    saveTabs: () => this.saveTabs(),
    run: (effect, tab) => this.run(effect, tab),
    openFile: (file, line) => this.openFile(file, line),
  });
  private readonly ui: ChatUi = {
    postTab: (tab, message) => this.postTab(tab, message),
    postTabs: () => this.postTabs(),
    status: (tab, key, extra) => this.status(tab, key, extra),
    refreshStatus: (tab) => this.refreshStatus(tab),
    saveTabs: () => this.saveTabs(),
    setConfigOptions: (tab, options) => this.setConfigOptions(tab, options),
    run: (effect, tab) => this.run(effect, tab),
  };
  private readonly usage = new TabUsage(this.ui);
  /** Keep and Undo above each change of the active tab, in editors. */
  readonly hunkLenses: vscode.CodeLensProvider = {
    onDidChangeCodeLenses: this.changes.onDidChangeLenses,
    provideCodeLenses: (document) =>
      this.runtime.runPromise(this.changes.lenses(this.tabs.active, document).pipe(Effect.orElseSucceed(() => []))),
  };
  private readonly tabWorktrees: TabWorktrees = new TabWorktrees({
    tabs: () => this.tabs,
    postTab: (tab, message) => this.postTab(tab, message),
    postTabs: () => this.postTabs(),
    status: (tab, key) => this.status(tab, key),
    confirmStartOver: (tab) => this.sessions.confirmStartOver(tab),
    startOver: (tab, change) => this.sessions.startOver(tab, change),
  });
  private readonly history = new HistoryRequests();
  /** Attachments added before the webview was ready are delivered on "ready". */
  private readonly attachments = new AttachmentQueue((attachments, prompt) => {
    if (!this.view) {
      return false;
    }
    this.post({ type: "addAttachments", attachments, prompt });
    return true;
  });
  private readonly focus = thenable(() => vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`));
  /** What VS Code's commands add to the composer. */
  readonly composer = new ComposerCommands(this.attachments, this.focus);
  private readonly viewMessages = new ViewMessages({
    post: (message) => this.post(message),
    attachments: this.attachments,
    permissions: this.permissions,
    openFile: (file, line) => this.openFile(file, line),
  });
  private readonly statusBar = new ChatStatusBar(ChatViewProvider.showAttentionCommand);
  /** A status bar update is due; several changes in one tick share it. */
  private statusBarDue = false;
  /** Counts status bar updates, so one that took longer doesn't overwrite a newer one. */
  private statusBarRun = 0;
  private readonly disposables: vscode.Disposable[] = [];
  /** Pending `writeTabs`; flushed on dispose. */
  private saveTimer?: ReturnType<typeof setTimeout>;
  /** codeAcp.followAgent: the active tab's agent's tool locations are opened in the editor. */
  private followAgent = readSettings().followAgent;
  private readonly follower = new Follower(this.followAgent, {
    activeTab: () => this.tabs.active,
    run: (effect, tab) => this.run(effect, tab),
  });

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly runtime: AppRuntime,
    private readonly manager: AgentManager["Service"],
    private readonly updates: AgentUpdates["Service"],
  ) {
    const saved = context.workspaceState.get(TABS_KEY);
    this.tabs = new TabList(saved, defaultCwd);
    if (saved === undefined) {
      this.tabs.active.wantsWorktree = readSettings().worktreeForNewTabs;
    }
    this.lastOptions = new LastOptions(context.globalState);
    const parts = {
      tabs: this.tabs,
      changes: this.changes,
      usage: this.usage,
      tabWorktrees: this.tabWorktrees,
    };
    this.turns = new TabTurns(
      {
        ...this.ui,
        ...parts,
        ensureSession: (tab) => this.sessions.ensureSession(tab),
        cancelTab: (tab) => this.sessions.cancelTab(tab),
        finished: (tab) => this.attention.raise(tab, "finished"),
        turnEnded: (tab) => {
          this.changes.post(tab);
          this.run(this.refreshBranch(tab), tab);
          if (tab.sessionId) {
            this.status(tab, "chat.ready");
          } else {
            this.refreshStatus(tab);
          }
        },
      },
      this.tabs.lastTurn + 1,
    );
    this.sessions = new TabSessions({
      ...this.ui,
      ...parts,
      agents: this.agents,
      permissions: this.permissions,
      turns: this.turns,
      lastOptions: this.lastOptions,
      selectTab: (tab) => this.selectTab(tab),
      getAgent: (tab) => this.getAgent(tab),
    });
    // Raw bytes of draft attachments, which are too big for workspaceState.
    this.drafts = new DraftStore(path.join((context.storageUri ?? context.globalStorageUri).fsPath, "drafts"), () => this.tabs.all);
    this.run(pruneTempFiles);
    this.disposables.push(
      this.statusBar,
      manager.onDidChange(() =>
        this.run(
          Effect.gen({ self: this }, function* () {
            this.updateStatusBar();
            yield* this.postAgent;
            // A removed agent's tabs move to the default agent.
            for (const id of this.agents.ids()) {
              if (!(yield* this.manager.has(id))) {
                yield* this.restart(id);
              }
            }
          }),
        ),
      ),
      updates.onDidChange(() => this.run(this.postAgent)),
      this.changes,
      this.follower,
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("codeAcp.followAgent")) {
          this.followAgent = readSettings().followAgent;
          this.follower.setEnabled(this.followAgent);
          this.post({ type: "followAgent", enabled: this.followAgent });
        }
        if (e.affectsConfiguration("codeAcp.autoScroll")) {
          this.post({ type: "autoScroll", enabled: readSettings().autoScroll });
        }
        if (e.affectsConfiguration("codeAcp.showChanges")) {
          this.post({ type: "showChanges", enabled: readSettings().showChanges });
          this.changes.refreshLenses();
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.postFolders()),
      vscode.window.onDidChangeWindowState((state) => {
        this.attention.refresh();
        // A checkout made in another window or a terminal.
        if (state.focused) {
          this.run(this.refreshBranch(this.tabs.active));
        }
      }),
      // Edits the user saves change the counts.
      vscode.workspace.onDidSaveTextDocument((doc) => {
        for (const tab of this.tabs.all) {
          this.changes.postIfTracked(tab, doc.uri.fsPath);
        }
      }),
      onDidChangeLocale(() => {
        this.post(webviewL10n());
        this.updateStatusBar();
        this.run(this.postAgent);
        for (const tab of this.tabs.all) {
          this.refreshStatus(tab);
        }
      }),
    );
    this.updateStatusBar();
  }

  /** Runs an effect from a VS Code callback, showing failures in the chat (in `tab`, else the active one). */
  private run<E>(effect: Effect.Effect<void, E, AppServices>, tab?: Tab): void {
    void runIn(this.runtime, effect, (text) => this.postTab(tab ?? this.tabs.active, { type: "error", text }));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const root = this.context.extensionUri;
    view.webview.options = { enableScripts: true, localResourceRoots: webviewRoots(root) };
    view.webview.html = webviewHtml(view.webview, root, "chat", `${view.webview.cspSource} data: https://cdn.agentclientprotocol.com`);
    view.webview.onDidReceiveMessage((msg: FromWebview) => this.run(this.onMessage(msg), this.tabOf(msg)));
    view.onDidChangeVisibility(() => this.attention.refresh());
    view.onDidDispose(() => (this.view = undefined));
    this.showBadge();
  }

  private showBadge(): void {
    this.updateStatusBar();
    if (this.view) {
      const count = this.attention.count;
      this.view.badge = count ? { value: count, tooltip: t("attention.badge", count) } : undefined;
    }
  }

  /** Announces a tab that wants the user (codeAcp.notifications); "Show" brings it up. */
  private notify(tab: Tab, reason: AttentionReason): void {
    if (!readSettings().notifications) {
      return;
    }
    const title = tab.name ?? tab.title ?? t("chat.untitled");
    const show = t("attention.show");
    const message = t(`attention.${reason}`, title);
    void vscode.window.showInformationMessage(message, show).then((picked) => {
      if (picked === show) {
        this.run(this.reveal(tab), tab);
      }
    });
  }

  /** Shows the active tab's agent in the view title, its agent and model in the status bar, and what the tabs are doing. */
  private updateStatusBar(): void {
    if (this.statusBarDue) {
      return;
    }
    this.statusBarDue = true;
    queueMicrotask(() => {
      this.statusBarDue = false;
      this.run(this.showStatusBar);
    });
  }

  private get showStatusBar(): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const run = ++this.statusBarRun;
      const tab = this.tabs.active;
      const agentId = tab.running?.agentId ?? (yield* this.agentIdOf(tab));
      const agent = agentId === undefined ? undefined : (yield* this.manager.agents).find((a) => a.id === agentId)?.name;
      if (run !== this.statusBarRun) {
        return;
      }
      if (this.view) {
        this.view.description = agent;
      }
      const model = modelOption(tab.configOptions);
      const thought = thoughtOption(tab.configOptions);
      this.statusBar.show({
        agent,
        model: model && choicesOf(model).find((c) => c.value === model.currentValue)?.name,
        effort: thought && choicesOf(thought).find((c) => c.value === thought.currentValue)?.name,
        waiting: this.permissions.owners.length,
        finished: this.attention.owners("finished").length,
        running: this.tabs.all.filter((t) => t.busy).length,
      });
    });
  }

  /**
   * Shows the tab that needs the user (status bar item): the first waiting for a permission or an answer, else one that finished
   * unseen, else a running one when the active tab is idle, else the active tab.
   */
  readonly showAttention = Effect.fn("ChatView.showAttention")(function* (this: ChatViewProvider) {
    const active = this.tabs.active;
    const tab =
      this.permissions.owners[0] ??
      this.attention.owners("finished")[0] ??
      (active.busy ? undefined : this.tabs.all.find((t) => t.busy)) ??
      active;
    yield* this.reveal(tab);
  });

  /** Shows the chat with `tab` active. */
  private readonly reveal = Effect.fn("ChatView.reveal")(function* (this: ChatViewProvider, tab: Tab) {
    if (!this.tabs.has(tab)) {
      return;
    }
    yield* this.focus;
    if (this.tabs.active !== tab) {
      yield* this.selectTab(tab);
    }
  });

  /** Keeps the session's config options (null or absent: unchanged) for the status bar. */
  private setConfigOptions(tab: Tab, options: ReadonlyArray<acp.SessionConfigOption> | null | undefined): void {
    if (options) {
      tab.configOptions = options;
      this.updateStatusBar();
    }
  }

  private post(message: unknown): void {
    void this.view?.webview.postMessage(message);
  }

  /** Posts a message that belongs to one tab's conversation. */
  private postTab(tab: Tab, message: Record<string, unknown>): void {
    // A closed tab's turn may still be winding down.
    if (this.tabs.has(tab)) {
      this.post({ ...message, tab: tab.id });
    }
  }

  private postTabs(): void {
    this.post({ type: "tabs", tabs: this.tabs.info, active: this.tabs.active.id });
    // Answers with another post only when the branch changed.
    this.run(this.refreshBranch(this.tabs.active));
    this.attention.refresh();
    this.updateStatusBar();
    this.saveTabs();
  }

  private postFolders(): void {
    this.post({ type: "folders", folders: workspaceFolders() });
  }

  /** Reads what is checked out in the tab's folder; the agent or the user may have changed it at any time. */
  private readonly refreshBranch = Effect.fn("ChatView.refreshBranch")(function* (this: ChatViewProvider, tab: Tab) {
    const { cwd } = tab;
    const branch = yield* (yield* Worktrees).branchOf(cwd);
    // The tab may have moved on while git ran.
    if (tab.cwd === cwd && tab.branch !== branch) {
      tab.branch = branch;
      this.postTabs();
    }
  });

  /** The composer's agent picker: installed and custom agents, their pending updates, and the default for new tabs. */
  private get postAgent(): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const activeId = yield* this.manager.activeId;
      const pending = new Map((yield* this.updates.pending).map((u) => [u.installed.id, u.latest.version]));
      const agents = (yield* this.manager.agents).map((a) => ({
        id: a.id,
        name: a.version ? `${a.name} ${a.version}` : a.name,
        icon: a.icon,
        update: pending.get(a.id),
      }));
      this.post({ type: "agent", agents, activeId });
    });
  }

  private status(tab: Tab, key: MessageKey, extra: Record<string, unknown> = {}): void {
    tab.lastStatus = { key, extra };
    // Called whenever `busy` changes.
    this.updateStatusBar();
    this.postTab(tab, { type: "status", text: t(key), busy: tab.busy, ...extra });
  }

  /** Re-posts the last status, e.g. after `busy` changed or the language did. */
  private refreshStatus(tab: Tab): void {
    if (tab.lastStatus) {
      this.status(tab, tab.lastStatus.key, tab.lastStatus.extra);
    }
  }

  /** Saves the tabs so they come back after a reload, batching changes that come in quick succession. */
  private saveTabs(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.writeTabs(), SAVE_TABS_DELAY_MS);
  }

  private writeTabs(): void {
    this.saveTimer = undefined;
    const value = this.tabs.saved;
    this.run(thenable(() => this.context.workspaceState.update(TABS_KEY, value)));
  }

  /** Keeps the tab's unsent content (a string updates only its text) and saves it. */
  private readonly setDraft = Effect.fn("ChatView.setDraft")(function* (this: ChatViewProvider, tab: Tab, update: Draft | string) {
    // The tab may have closed while the files were written.
    yield* this.drafts.set(tab, update, () => this.tabs.has(tab));
    if (this.tabs.has(tab)) {
      this.saveTabs();
    }
  });

  /** Opens a path from the shown conversation, so a relative one starts at the active tab's folder. */
  private openFile(file: string, line: number | undefined) {
    return openFile(file, line, this.tabs.active.cwd);
  }

  private tabOf(msg: FromWebview): Tab | undefined {
    return "tab" in msg ? this.tabs.byId(msg.tab) : undefined;
  }

  private readonly onMessage = Effect.fn("ChatView.onMessage")(function* (this: ChatViewProvider, msg: FromWebview) {
    if ("tab" in msg) {
      const tab = this.tabs.byId(msg.tab);
      if (tab) {
        yield* this.onTabMessage(tab, msg);
      }
      return;
    }
    switch (msg.type) {
      case "ready":
        yield* this.drafts.load();
        this.post({ type: "environment", remote: vscode.env.remoteName !== undefined });
        this.postFolders();
        this.postTabs();
        yield* this.postAgent;
        this.post({ type: "followAgent", enabled: this.followAgent });
        this.post({ type: "autoScroll", enabled: readSettings().autoScroll });
        this.post({ type: "showChanges", enabled: readSettings().showChanges });
        for (const each of this.tabs.all) {
          this.refreshStatus(each);
          this.usage.postSaved(each);
          this.changes.postIfTracked(each);
          if (each.queue.length > 0) {
            this.turns.postQueue(each);
          }
        }
        this.attachments.flush();
        yield* this.sessions.ensureSession(this.tabs.active);
        break;
      case "newTab":
        yield* this.newSession();
        break;
      case "history":
        yield* this.showHistory();
        break;
      case "openSession":
        yield* this.sessions.openSession(msg.sessionId, msg.cwd, msg.title);
        break;
      case "login":
        yield* this.login();
        break;
      case "updateAgent": {
        const update = (yield* this.updates.pending).find((u) => u.installed.id === msg.id);
        if (update) {
          yield* this.updateAgents([update]);
        }
        break;
      }
      default:
        yield* this.viewMessages.handle(msg);
    }
  });

  private readonly onTabMessage = Effect.fn("ChatView.onTabMessage")(function* (this: ChatViewProvider, tab: Tab, msg: TabMessage) {
    switch (msg.type) {
      case "send":
      case "sendQueuedNow":
      case "unqueue":
      case "editMessage":
      case "retry":
        yield* this.turns.onMessage(tab, msg);
        break;
      case "fork":
        yield* this.sessions.fork(tab, msg.turn);
        break;
      case "cancel":
        yield* this.sessions.cancelTab(tab);
        break;
      case "draft":
        yield* this.setDraft(tab, msg.draft);
        break;
      case "draftText":
        yield* this.setDraft(tab, msg.text);
        break;
      case "selectTab":
        yield* this.selectTab(tab);
        break;
      case "closeTab":
        yield* this.closeTab(tab);
        yield* this.drafts.prune;
        break;
      case "pinTab":
        if (this.tabs.pin(tab, msg.pinned)) {
          this.postTabs();
        }
        break;
      case "renameTab":
        if (this.tabs.rename(tab, msg.title)) {
          this.postTabs();
        }
        break;
      case "moveTab":
        if (this.tabs.move(tab, msg.index)) {
          this.postTabs();
        }
        break;
      case "setAgent":
        yield* this.setTabAgent(tab, msg.id);
        break;
      case "setCwd":
        yield* this.sessions.setTabCwd(tab, msg.cwd);
        break;
      case "pickWorktree":
        yield* this.tabWorktrees.pick(tab);
        break;
      case "setConfig":
        if (tab.running && tab.sessionId) {
          const { agentId } = tab.running;
          const before = tab.configOptions;
          const res = yield* tab.running.agent.setConfigOption(tab.sessionId, msg.configId, msg.value);
          const picked = readSettings().rememberSessionOptions
            ? this.lastOptions.picked(agentId, before, msg.configId, msg.value)
            : undefined;
          if (picked) {
            yield* thenable(() => picked);
          }
          this.setConfigOptions(tab, res.configOptions);
          this.postTab(tab, { type: "configOptions", configOptions: res.configOptions });
        }
        break;
      case "killTerminal":
        if (tab.running && tab.sessionId) {
          yield* tab.running.agent.killTerminal(tab.sessionId, msg.terminalId);
        }
        break;
      default:
        yield* this.changes.onMessage(tab, msg);
    }
  });

  /** The agent `tab` runs on: its pick while it exists, else the default (last picked). */
  private readonly agentIdOf = Effect.fn("ChatView.agentIdOf")(function* (this: ChatViewProvider, tab: Tab) {
    if (tab.agentId && (yield* this.manager.has(tab.agentId))) {
      return tab.agentId;
    }
    return yield* this.manager.activeId;
  });

  /** The process of the agent `tab` runs on, started on first use; the tab is set to that agent. */
  private readonly getAgent = Effect.fn("ChatView.getAgent")(function* (this: ChatViewProvider, tab: Tab) {
    const agentId = yield* this.agentIdOf(tab);
    if (!agentId) {
      return yield* new NoAgentError();
    }
    if (tab.agentId !== agentId) {
      tab.agentId = agentId;
      this.postTabs();
    }
    return yield* this.agents.get(agentId, this.startAgent(agentId, tab));
  });

  private readonly startAgent = Effect.fn("ChatView.startAgent")(function* (
    this: ChatViewProvider,
    agentId: string,
    tab: Tab,
  ) {
    const command = yield* this.manager.command(agentId);
    if (!command) {
      return yield* new NoAgentError();
    }
    this.status(tab, "chat.starting");
    const scope = yield* Scope.make();
    // Set once spawned; the agent sends nothing before it answers `initialize`.
    let running: RunningAgent | undefined;
    const tabFor = (sessionId: string) => (running ? this.tabs.forSession(running, sessionId) : undefined);
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
        return tab ? this.permissions.request(tab, req, signal) : Effect.succeed(CANCELLED);
      },
      elicit: (req, signal) => {
        // Only questions about a session have a tab to show in.
        const tab = "sessionId" in req ? tabFor(req.sessionId) : undefined;
        return tab ? this.permissions.elicit(tab, req, signal) : Effect.succeed(ELICITATION_CANCELLED);
      },
      onTerminal: (snapshot) => {
        const tab = tabFor(snapshot.sessionId);
        if (tab) {
          this.postTab(tab, { type: "terminal", snapshot });
        }
      },
      onFileWritten: (sessionId, file) => {
        const tab = tabFor(sessionId);
        if (tab) {
          this.changes.post(tab);
          this.follower.fileWritten(tab, file);
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
      replay.turn = this.turns.nextTurn();
      replay.turns.push(replay.turn);
    }
    replay.blocks.push(update.content);
    tab.sent.set(replay.turn, { parts: replayedParts(replay.blocks) });
    return replay.turn;
  }

  private onSessionUpdate(tab: Tab, n: acp.SessionNotification): void {
    const { update } = n;
    if (update.sessionUpdate === "session_info_update" && update.title !== undefined) {
      tab.title = update.title ?? undefined;
      this.postTabs();
    }
    this.postTab(tab, { type: "update", update, turn: this.replayTurn(tab, update) });
    if (update.sessionUpdate === "config_option_update") {
      this.setConfigOptions(tab, update.configOptions);
    }
    if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      this.follower.toolCall(tab, update);
      // The tool may have changed files, however it did.
      if (update.status === "completed" || update.status === "failed") {
        this.changes.post(tab);
      }
    }
    if (update.sessionUpdate === "usage_update") {
      this.usage.onUpdate(tab, n.sessionId, update);
    }
  }

  private onAgentExit(running: RunningAgent): void {
    if (!this.agents.isCurrent(running)) {
      return;
    }
    this.agents.forget(running);
    for (const tab of this.tabs.all) {
      if (tab.running !== running) {
        continue;
      }
      this.permissions.cancel(tab);
      if (tab.sessionId && tab.used) {
        tab.reopen = { sessionId: tab.sessionId, cwd: tab.cwd, agentId: running.agentId };
      }
      tab.sessionId = undefined;
      tab.running = undefined;
      tab.configOptions = undefined;
      tab.busy = false;
      // The queue waits for the user rather than starting the agent again.
      tab.steer = false;
      this.status(tab, "chat.stopped", { stopped: true });
    }
    this.postTabs();
    // A separate fiber: this one runs inside the scope being closed.
    this.runtime.runFork(Scope.close(running.scope, Exit.void));
  }

  /** Switches `tab` to another agent, starting over in a fresh session; it also becomes the default for new tabs. */
  private readonly setTabAgent = Effect.fn("ChatView.setTabAgent")(function* (
    this: ChatViewProvider,
    tab: Tab,
    agentId: string,
  ) {
    const change = tab.agentId !== agentId;
    if (change && !(yield* this.sessions.confirmStartOver(tab))) {
      return;
    }
    yield* this.manager.setActive(agentId);
    if (change) {
      yield* this.sessions.startOver(tab, (tab) => (tab.agentId = agentId));
    }
  });

  /** Offers the worktrees the active tab can run in (command palette, view menu). */
  readonly pickWorktree = Effect.fn("ChatView.pickWorktree")(function* (this: ChatViewProvider) {
    yield* this.tabWorktrees.pick(this.tabs.active);
  });

  /** The agent the active tab runs on. */
  get activeAgentId(): Effect.Effect<string | undefined> {
    return this.agentIdOf(this.tabs.active);
  }

  /** Switches the active tab to another agent (command palette). */
  readonly setAgent = Effect.fn("ChatView.setAgent")(function* (this: ChatViewProvider, agentId: string) {
    yield* this.setTabAgent(this.tabs.active, agentId);
  });

  /** Opens a new tab with a fresh session, in the active editor's folder or else the active tab's. */
  readonly newSession = Effect.fn("ChatView.newSession")(function* (this: ChatViewProvider) {
    const tab = this.tabs.add(cwdForNewTab(this.tabs.length ? (this.tabs.active.worktree?.base ?? this.tabs.active.cwd) : undefined));
    tab.agentId = yield* this.manager.activeId;
    tab.wantsWorktree = readSettings().worktreeForNewTabs;
    this.tabs.active = tab;
    this.postTabs();
    yield* this.focus;
    this.post({ type: "focusComposer" });
    yield* this.sessions.ensureSession(tab);
  });

  /** The commands of the lenses, which keep or undo a change of the tab that offered it. */
  hunkCommands(): vscode.Disposable[] {
    const register = <E>(command: string, review: (tab: Tab, file: string, hunk: ChangeHunk) => Effect.Effect<void, E, AppServices>) =>
      vscode.commands.registerCommand(command, (tabId: number, file: string, hunk: ChangeHunk) => {
        const tab = this.tabs.byId(tabId);
        if (tab) {
          this.run(review(tab, file, hunk), tab);
        }
      });
    return [
      register(KEEP_HUNK_COMMAND, (tab, file, hunk) => this.changes.keepHunk(tab, file, hunk)),
      register(UNDO_HUNK_COMMAND, (tab, file, hunk) => this.changes.undoHunk(tab, file, hunk)),
    ];
  }

  private readonly selectTab = Effect.fn("ChatView.selectTab")(function* (this: ChatViewProvider, tab: Tab) {
    this.tabs.active = tab;
    this.changes.refreshLenses();
    this.postTabs();
    if (!tab.busy) {
      yield* this.sessions.ensureSession(tab);
    }
  });

  private readonly closeTab = Effect.fn("ChatView.closeTab")(function* (this: ChatViewProvider, tab: Tab) {
    if (!this.tabs.has(tab)) {
      return;
    }
    const fate = yield* this.tabWorktrees.askRelease(tab);
    if (fate === "cancel") {
      return;
    }
    if (tab.busy) {
      yield* this.sessions.cancelTab(tab).pipe(Effect.ignore);
    }
    this.permissions.cancel(tab);
    this.follower.forget(tab);
    this.attention.clear(tab);
    const index = this.tabs.remove(tab);
    if (index < 0) {
      // Closed by another caller while its turn was being cancelled.
      return;
    }
    clearTimeout(tab.changesTimer);
    if (tab.sessionId) {
      yield* this.sessions.closeSessionOnAgent(tab.running, tab.sessionId);
    }
    yield* this.sessions.stopIdleAgents;
    if (tab.worktree && fate === "delete") {
      yield* this.tabWorktrees.discard(tab.worktree, tab.cwd);
    }
    if (this.tabs.length === 0) {
      yield* this.newSession();
      return;
    }
    if (this.tabs.active === tab) {
      this.tabs.active = this.tabs.at(Math.min(index, this.tabs.length - 1))!;
    }
    this.postTabs();
    yield* this.sessions.ensureSession(this.tabs.active);
  });

  /** Shows the active tab's agent's past sessions in the workspace folders, in the chat view. */
  readonly showHistory = Effect.fn("ChatView.showHistory")(function* (this: ChatViewProvider) {
    yield* this.focus;
    const latest = this.history.next();
    const post = (message: object) => {
      if (latest()) {
        this.post({ type: "history", ...message });
      }
    };
    post({ loading: true, sessions: [] });
    const running = yield* this.getAgent(this.tabs.active).pipe(Effect.catchTag("NoAgentError", () => Effect.undefined));
    const worktrees = yield* Worktrees;
    const roots = workspaceFolders().map((f) => f.path);
    const kept = yield* Effect.forEach(roots, (root) => worktrees.list(root).pipe(Effect.orElseSucceed(() => [])));
    const folders = new Set([...roots, ...kept.flat().map((placed) => placed.cwd), this.tabs.active.cwd]);
    const listing = running ? yield* listHistory(running.agent, [...folders]) : undefined;
    if (!listing || listing.unsupported) {
      post({ unsupported: true, sessions: [] });
      return;
    }
    post({
      sessions: listing.sessions,
      currentId: this.tabs.active.sessionId,
      openIds: this.tabs.all.flatMap((tab) => {
        const id = tab.sessionId ?? tab.reopen?.sessionId;
        return id ? [id] : [];
      }),
      canOpen: listing.canOpen,
    });
  });

  /** Runs a tab context menu action (webview context menu); pinned tabs are never closed. */
  readonly tabAction = Effect.fn("ChatView.tabAction")(function* (
    this: ChatViewProvider,
    id: number,
    action: "pin" | "unpin" | "rename" | "close" | "closeOthers" | "closeToRight" | "fork" | "worktree",
  ) {
    const tab = this.tabs.byId(id);
    if (!tab) {
      return;
    }
    switch (action) {
      case "pin":
      case "unpin":
        if (this.tabs.pin(tab, action === "pin")) {
          this.postTabs();
        }
        return;
      case "fork":
        yield* this.sessions.fork(tab, undefined);
        return;
      case "worktree":
        yield* this.tabWorktrees.pick(tab);
        return;
      case "rename":
        // Edited in place in the tab strip, which answers with "renameTab".
        this.post({ type: "renameTab", tab: tab.id });
        return;
      case "close":
        if (!tab.pinned) {
          yield* this.closeTab(tab);
        }
        return;
      case "closeOthers":
      case "closeToRight": {
        const index = this.tabs.indexOf(tab);
        const targets = this.tabs.all.filter((each, i) => !each.pinned && (action === "closeOthers" ? each !== tab : i > index));
        if (targets.length && this.tabs.active !== tab && targets.includes(this.tabs.active)) {
          yield* this.selectTab(tab);
        }
        for (const each of targets) {
          yield* this.closeTab(each);
        }
        return;
      }
    }
  });

  /** Quotes text selected in the transcript into the composer (webview context menu). */
  quote(text: string): void {
    if (text.trim()) {
      this.post({ type: "quote", text });
    }
  }

  /** Stops the active tab's turn. */
  readonly cancel = Effect.fn("ChatView.cancel")(function* (this: ChatViewProvider) {
    yield* this.sessions.cancelTab(this.tabs.active);
  });

  readonly login = Effect.fn("ChatView.login")(function* (this: ChatViewProvider) {
    const running = yield* this.getAgent(this.tabs.active);
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
      const cmd = yield* this.manager.command(running.agentId);
      if (!cmd) {
        return;
      }
      const terminal = vscode.window.createTerminal({
        name: "ACP Login",
        shellPath: cmd.command,
        shellArgs: [...cmd.args, ...(picked.args ?? [])],
        env: { ...cmd.env, ...(picked.env ?? {}) },
        cwd: this.tabs.active.cwd,
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
      yield* this.sessions.ensureSession(this.tabs.active);
    }
  });

  /** Installs the updates, then offers to restart the updated agents that are running on the old version. */
  readonly updateAgents = Effect.fn("ChatView.updateAgents")(function* (
    this: ChatViewProvider,
    updates: ReadonlyArray<AgentUpdate>,
  ) {
    const updated = yield* this.updates.install(updates);
    if (!updated.length) {
      return;
    }
    const list = updated.map((agent) => `${agent.name} ${agent.version}`).join(", ");
    const running = updated.filter((agent) => this.agents.ids().includes(agent.id));
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
   * Restarts the agent `agentId`, or every agent; their tabs start over, the active one right away and the others
   * when selected.
   */
  readonly restart = Effect.fn("ChatView.restart")(function* (this: ChatViewProvider, agentId?: string) {
    const stopped = this.agents.take(agentId);
    for (const tab of this.tabs.all) {
      const affected = tab.running
        ? stopped.includes(tab.running)
        : agentId === undefined || (tab.reopen?.agentId ?? tab.agentId) === agentId;
      if (!affected) {
        continue;
      }
      this.permissions.cancel(tab);
      resetConversation(tab);
      this.postTab(tab, { type: "reset" });
      this.changes.clear(tab);
    }
    this.postTabs();
    yield* stopAll(stopped);
    yield* this.sessions.ensureSession(this.tabs.active);
  });

  dispose(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.writeTabs();
    }
    this.permissions.cancel();
    for (const tab of this.tabs.all) {
      clearTimeout(tab.changesTimer);
    }
    // Scope finalizers are synchronous, so the processes are killed before this returns.
    this.runtime.runFork(stopAll(this.agents.take()));
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
