import type * as acp from "@agentclientprotocol/sdk";
import { Effect } from "effect";
import * as path from "node:path";
import * as vscode from "vscode";
import type { AgentManager } from "../agentManager";
import type { AgentUpdate, AgentUpdates } from "../agentUpdates";
import { onDidChangeLocale, t, webviewL10n, type MessageKey } from "../i18n";
import { runIn, thenable, type AppRuntime, type AppServices } from "../runtime";
import { readSettings } from "../settings";
import { webviewHtml, webviewRoots } from "../webview";
import { Worktrees } from "../worktrees";
import { AgentPool, stopAll } from "./agents";
import { Attention } from "./attention";
import { AttachmentQueue, pruneTempFiles } from "./attachments";
import { ChangeReview, KEEP_HUNK_COMMAND, UNDO_HUNK_COMMAND } from "./changes";
import { ComposerCommands } from "./composerCommands";
import { DraftStore } from "./drafts";
import { LastOptions } from "./lastOptions";
import { Follower } from "./follow";
import { HistoryRequests, listHistory } from "./history";
import type { ChatUi } from "./host";
import { ChatIndicators } from "./indicators";
import { ViewMessages } from "./messages";
import { openFile } from "./openFile";
import { Permissions } from "./permissions";
import { TabSessions } from "./sessions";
import type { ChangeHunk, Draft, FromWebview, TabMessage } from "./protocol";
import { TabActions, type TabAction } from "./tabActions";
import { TabAgents } from "./tabAgents";
import { TabList, type Tab } from "./tabs";
import { TabTurns } from "./turns";
import { TabUsage } from "./usage";
import { TabWorktrees } from "./worktrees";
import { defaultCwd, workspaceFolders } from "../workspace";

const TABS_KEY = "codeAcp.tabs";

/** Tabs are written to workspaceState at most this often; usage updates arrive many times per turn. */
const SAVE_TABS_INTERVAL_MS = 100;

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
  private readonly tabAgents: TabAgents;
  private readonly tabActions: TabActions;
  private readonly indicators: ChatIndicators;
  private readonly permissions = new Permissions<Tab>({
    shown: (tab, id, ask) => {
      tab.turnStats?.askShown();
      this.view?.show(true);
      if (ask.kind === "permission") {
        const { toolCall, options } = ask.request;
        this.postTab(tab, { type: "permissionRequest", id, toolCall, options });
      } else {
        const { request } = ask;
        const toolCallId = "toolCallId" in request ? request.toolCallId : undefined;
        const asked = request.mode === "url" ? { url: request.url, elicitationId: request.elicitationId } : { schema: request.requestedSchema };
        this.postTab(tab, { type: "elicitationRequest", id, message: request.message, toolCallId, ...asked });
      }
      this.attention.raise(tab, ask.kind === "permission" ? "permission" : "question");
      this.indicators.update();
    },
    done: (tab, id, answer) => {
      tab.turnStats?.askDone();
      if (answer.kind === "permission") {
        this.postTab(tab, { type: "permissionDone", id });
      } else {
        this.postTab(tab, { type: "elicitationDone", id, action: answer.response.action });
      }
      this.attention.settle(tab, answer.kind === "permission" ? "permission" : "question");
      this.indicators.update();
    },
  });
  /** Tabs that finished or wait for a permission while the user looked elsewhere: the view's badge and notifications. */
  private readonly attention = new Attention<Tab>({
    sees: (tab) => vscode.window.state.focused && this.view?.visible === true && this.tabs.active === tab,
    badge: () => this.indicators.showBadge(),
    notify: (tab, reason) => this.indicators.notify(tab, reason),
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
    globalState: () => this.context.globalState,
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
  /**
   * Shows the chat with the caret in the composer. The message follows the focus command because
   * that command moves focus to the webview's outer frame, away from a composer focused before it.
   */
  private readonly focusComposer = this.focus.pipe(Effect.andThen(Effect.sync(() => this.post({ type: "focusComposer" }))));
  /** What VS Code's commands add to the composer. */
  readonly composer = new ComposerCommands(this.attachments, this.focusComposer);
  private readonly viewMessages = new ViewMessages({
    post: (message) => this.post(message),
    attachments: this.attachments,
    permissions: this.permissions,
    openFile: (file, line) => this.openFile(file, line),
  });
  private readonly disposables: vscode.Disposable[] = [];
  /** Pending `writeTabs`; flushed on dispose, which is too late to be kept when the window reloads. */
  private saveTimer?: ReturnType<typeof setTimeout>;
  private lastTabsWrite = 0;
  /** codeAcp.followAgent: the active tab's agent's tool locations are opened in the editor. */
  private followAgent = readSettings().followAgent;
  private readonly follower = new Follower(this.followAgent, {
    activeTab: () => this.tabs.active,
    run: (effect, tab) => this.run(effect, tab),
  });

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly runtime: AppRuntime,
    manager: AgentManager["Service"],
    updates: AgentUpdates["Service"],
  ) {
    const saved = context.workspaceState.get(TABS_KEY);
    this.tabs = new TabList(saved, defaultCwd);
    if (saved === undefined) {
      this.tabs.active.wantsWorktree = readSettings().worktreeForNewTabs;
    }
    this.lastOptions = new LastOptions(context.globalState);
    this.indicators = new ChatIndicators({
      manager,
      tabs: this.tabs,
      permissions: this.permissions,
      attention: this.attention,
      usage: this.usage,
      showAttentionCommand: ChatViewProvider.showAttentionCommand,
      showUsageCommand: "codeAcp.showUsage",
      view: () => this.view,
      agentIdOf: (tab) => this.tabAgents.agentIdOf(tab),
      reveal: (tab) => this.run(this.tabActions.reveal(tab), tab),
      run: (effect) => this.run(effect),
    });
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
      selectTab: (tab) => this.tabActions.selectTab(tab),
      getAgent: (tab) => this.tabAgents.getAgent(tab),
    });
    this.tabAgents = new TabAgents({
      ...this.ui,
      ...parts,
      runtime,
      manager,
      updates,
      agents: this.agents,
      permissions: this.permissions,
      follower: this.follower,
      turns: this.turns,
      sessions: this.sessions,
      post: (message) => this.post(message),
    });
    this.tabActions = new TabActions({
      manager,
      tabs: this.tabs,
      sessions: this.sessions,
      tabWorktrees: this.tabWorktrees,
      permissions: this.permissions,
      attention: this.attention,
      changes: this.changes,
      follower: this.follower,
      focus: this.focus,
      post: (message) => this.post(message),
      postTabs: () => this.postTabs(),
    });
    // Raw bytes of draft attachments, which are too big for workspaceState.
    this.drafts = new DraftStore(path.join((context.storageUri ?? context.globalStorageUri).fsPath, "drafts"), () => this.tabs.all);
    this.run(pruneTempFiles);
    this.disposables.push(
      this.indicators,
      manager.onDidChange(() =>
        this.run(
          Effect.gen({ self: this }, function* () {
            this.indicators.update();
            yield* this.tabAgents.postAgent;
            yield* this.tabAgents.restartRemoved();
          }),
        ),
      ),
      updates.onDidChange(() => this.run(this.tabAgents.postAgent)),
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
        if (e.affectsConfiguration("codeAcp.tracing")) {
          this.post({ type: "tracing", enabled: readSettings().tracing });
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
        this.indicators.update();
        this.run(this.tabAgents.postAgent);
        for (const tab of this.tabs.all) {
          this.refreshStatus(tab);
        }
      }),
    );
    this.indicators.update();
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
    this.indicators.showBadge();
  }

  /** Keeps the session's config options (null or absent: unchanged) for the status bar. */
  private setConfigOptions(tab: Tab, options: ReadonlyArray<acp.SessionConfigOption> | null | undefined): void {
    if (options) {
      tab.configOptions = options;
      this.indicators.update();
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
    this.indicators.update();
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

  private status(tab: Tab, key: MessageKey, extra: Record<string, unknown> = {}): void {
    tab.lastStatus = { key, extra };
    // Called whenever `busy` changes.
    this.indicators.update();
    this.postTab(tab, { type: "status", text: t(key), busy: tab.busy, ...extra });
  }

  /** Re-posts the last status, e.g. after `busy` changed or the language did. */
  private refreshStatus(tab: Tab): void {
    if (tab.lastStatus) {
      this.status(tab, tab.lastStatus.key, tab.lastStatus.extra);
    }
  }

  /**
   * Saves the tabs so they come back after a reload, which drops what isn't written yet. A change alone goes out at
   * once; a stream of them, such as usage during a turn, at most every SAVE_TABS_INTERVAL_MS.
   */
  private saveTabs(): void {
    if (this.saveTimer) {
      return;
    }
    const wait = Math.max(0, this.lastTabsWrite + SAVE_TABS_INTERVAL_MS - Date.now());
    this.saveTimer = setTimeout(() => this.writeTabs(), wait);
  }

  private writeTabs(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    this.lastTabsWrite = Date.now();
    const value = this.tabs.saved;
    this.run(thenable(() => this.context.workspaceState.update(TABS_KEY, value)));
  }

  /** Keeps the tab's unsent content (a string updates only its text) and saves it. */
  private readonly setDraft = Effect.fn("ChatView.setDraft")(function* (this: ChatViewProvider, tab: Tab, update: Draft | string) {
    // The tab may have closed while the files were written.
    yield* this.drafts.set(tab, update, () => this.tabs.has(tab));
    if (this.tabs.has(tab)) {
      // Written now, whatever was written just before; the webview batches typing.
      this.writeTabs();
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
        yield* this.tabAgents.postAgent;
        this.post({ type: "followAgent", enabled: this.followAgent });
        this.post({ type: "autoScroll", enabled: readSettings().autoScroll });
        this.post({ type: "showChanges", enabled: readSettings().showChanges });
        this.post({ type: "tracing", enabled: readSettings().tracing });
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
        yield* this.tabActions.newSession();
        break;
      case "history":
        yield* this.showHistory();
        break;
      case "openSession":
        yield* this.sessions.openSession(msg.sessionId, msg.cwd, msg.title);
        break;
      case "deleteSession":
        yield* this.deleteSession(msg.sessionId, msg.title);
        break;
      case "login":
        yield* this.tabAgents.login();
        break;
      case "updateAgent":
        yield* this.tabAgents.updateAgent(msg.id);
        break;
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
        yield* this.tabActions.selectTab(tab);
        break;
      case "closeTab":
        yield* this.tabActions.closeTab(tab);
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
        yield* this.tabAgents.setTabAgent(tab, msg.id);
        break;
      case "setCwd":
        yield* this.sessions.setTabCwd(tab, msg.cwd);
        break;
      case "pickWorktree":
        yield* this.tabWorktrees.pick(tab);
        break;
      case "setConfig":
        yield* this.sessions.setConfig(tab, msg.configId, msg.value);
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

  /** Offers the worktrees the active tab can run in (command palette, view menu). */
  readonly pickWorktree = Effect.fn("ChatView.pickWorktree")(function* (this: ChatViewProvider) {
    yield* this.tabWorktrees.pick(this.tabs.active);
  });

  /** The agent the active tab runs on. */
  get activeAgentId(): Effect.Effect<string | undefined> {
    return this.tabAgents.agentIdOf(this.tabs.active);
  }

  /** Switches the active tab to another agent (command palette). */
  readonly setAgent = Effect.fn("ChatView.setAgent")(function* (this: ChatViewProvider, agentId: string) {
    yield* this.tabAgents.setTabAgent(this.tabs.active, agentId);
  });

  newSession() {
    return this.tabActions.newSession();
  }

  showAttention() {
    return this.tabActions.showAttention();
  }

  tabAction(id: number, action: TabAction) {
    return this.tabActions.run(id, action);
  }

  login() {
    return this.tabAgents.login();
  }

  logout() {
    return this.tabAgents.logout();
  }

  updateAgents(updates: ReadonlyArray<AgentUpdate>) {
    return this.tabAgents.updateAgents(updates);
  }

  restart(agentId?: string) {
    return this.tabAgents.restart(agentId);
  }

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
    const running = yield* this.tabAgents.getAgent(this.tabs.active).pipe(Effect.catchTag("NoAgentError", () => Effect.undefined));
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
      canDelete: listing.canDelete,
    });
  });

  /** Deletes a session of the history; a failure can't go in the transcript, which the history covers. */
  private readonly deleteSession = Effect.fn("ChatView.deleteSession")(function* (this: ChatViewProvider, sessionId: string, title: string | undefined) {
    const deleted = yield* this.sessions.deleteSession(sessionId, title).pipe(
      Effect.catchTag("NoAgentError", () => Effect.succeed(false)),
      Effect.catchTags({
        AuthRequiredError: (err) => this.deleteFailed(err.message),
        AgentRequestError: (err) => this.deleteFailed(err.message),
      }),
    );
    if (deleted) {
      this.post({ type: "sessionDeleted", sessionId });
    }
  });

  private deleteFailed(message: string) {
    return Effect.sync(() => {
      void vscode.window.showErrorMessage(t("chat.deleteSessionFailed", message));
      return false;
    });
  }

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
