import type * as acp from "@agentclientprotocol/sdk";
import { Effect, Exit, Option, Predicate, Schema, Scope, Semaphore } from "effect";
import * as path from "node:path";
import * as vscode from "vscode";
import { canFork, spawnAgent, type AgentRequestError, type AgentStartError } from "../acpClient";
import type { AgentManager } from "../agentManager";
import type { AgentUpdate, AgentUpdates } from "../agentUpdates";
import { ClaudeSettings } from "../claudeSettings";
import { Completions } from "../completions";
import { ChangeSet } from "../fileChanges";
import { onDidChangeLocale, t, webviewL10n, type MessageKey } from "../i18n";
import { Problems, type ProblemScope } from "../problems";
import { runIn, thenable, type AppRuntime, type AppServices, type ExtensionCtx, type Output } from "../runtime";
import { readSettings } from "../settings";
import { TerminalContext } from "../terminalContext";
import { UsageLedger, type SessionRef } from "../usageLedger";
import { webviewHtml, webviewRoots } from "../webview";
import { AgentPool, stopAll } from "./agents";
import { Attention, type AttentionReason } from "./attention";
import { activeFileBlocks, activeFileName, attachmentBlock, AttachmentQueue, imageToTempFile, pruneTempFiles, selectionAttachments, uriAttachments } from "./attachments";
import { ChangeReview, confirm } from "./changes";
import { DraftStore } from "./drafts";
import { Follower } from "./follow";
import { canReopen, HistoryRequests, listHistory } from "./history";
import { CANCELLED, Permissions } from "./permissions";
import type { Attachment, Draft, FromWebview, LoadComposer, QueuedInfo, SentAttachment } from "./protocol";
import {
  messageText,
  resetConversation,
  TabList,
  usageOf,
  type OutgoingMessage,
  type Reopen,
  type RunningAgent,
  type Tab,
} from "./tabs";
import { replayedParts } from "./replay";
import { cwdForNewTab, defaultCwd, excludeGlob, folderOf, gitIgnored, isWorkspaceFolder, resolvePath, workspaceFolders } from "../workspace";

/** `_meta` key on Claude agents' `usage_update` naming the model the usage belongs to. */
const CLAUDE_MODEL_META = "_claude/model";

const TABS_KEY = "codeAcp.tabs";

const MAX_TITLE_LENGTH = 40;

/** Characters of a taken-back message quoted to the agent. */
const MAX_EXCERPT_LENGTH = 80;

/** Tabs are written to workspaceState at most this often; usage updates arrive many times per turn. */
const SAVE_TABS_DELAY_MS = 500;

function isTerminalAuth(m: acp.AuthMethod): m is acp.AuthMethodTerminal & { type: "terminal" } {
  return "type" in m && m.type === "terminal";
}

/** No agent installed or configured yet. */
class NoAgentError extends Schema.TaggedError<NoAgentError>()("NoAgentError", {}) {}

/** The chat view: tabs of ACP sessions, each on the process of its agent. */
export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = "codeAcp.chat";

  private view?: vscode.WebviewView;
  private readonly agents = new AgentPool();
  private readonly tabs: TabList;
  private readonly drafts: DraftStore;
  private readonly permissions = new Permissions<Tab>({
    shown: (tab, id, req) => {
      this.view?.show(true);
      this.postTab(tab, { type: "permissionRequest", id, toolCall: req.toolCall, options: req.options });
      this.attention.raise(tab, "permission");
    },
    done: (tab, id) => {
      this.postTab(tab, { type: "permissionDone", id });
      this.attention.settle(tab, "permission");
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
  private readonly history = new HistoryRequests();
  /** Attachments added before the webview was ready are delivered on "ready". */
  private readonly attachments = new AttachmentQueue((attachments) => {
    if (!this.view) {
      return false;
    }
    this.post({ type: "addAttachments", attachments });
    return true;
  });
  private readonly disposables: vscode.Disposable[] = [];
  /** Pending `writeTabs`; flushed on dispose. */
  private saveTimer?: ReturnType<typeof setTimeout>;
  /** Turn ids, unique across tabs. */
  private nextTurn: number;
  /** Ids of queued messages. */
  private nextQueued = 1;
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
    this.tabs = new TabList(context.workspaceState.get(TABS_KEY), defaultCwd);
    this.nextTurn = this.tabs.lastTurn + 1;
    // Raw bytes of draft attachments, which are too big for workspaceState.
    this.drafts = new DraftStore(path.join((context.storageUri ?? context.globalStorageUri).fsPath, "drafts"), () => this.tabs.all);
    this.run(pruneTempFiles);
    this.disposables.push(
      manager.onDidChange(() =>
        this.run(
          Effect.gen({ self: this }, function* () {
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
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.postFolders()),
      vscode.window.onDidChangeWindowState(() => this.attention.refresh()),
      vscode.window.onDidChangeActiveTextEditor(() => this.postActiveFile()),
      // Edits the user saves change the counts.
      vscode.workspace.onDidSaveTextDocument((doc) => {
        for (const tab of this.tabs.all) {
          this.changes.postIfTracked(tab, doc.uri.fsPath);
        }
      }),
      onDidChangeLocale(() => {
        this.post(webviewL10n());
        this.run(this.postAgent);
        for (const tab of this.tabs.all) {
          this.refreshStatus(tab);
        }
      }),
    );
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
    const message = t(reason === "permission" ? "attention.permission" : "attention.finished", title);
    void vscode.window.showInformationMessage(message, show).then((picked) => {
      if (picked === show) {
        this.run(this.reveal(tab), tab);
      }
    });
  }

  /** Shows the chat with `tab` active. */
  private readonly reveal = Effect.fn("ChatView.reveal")(function* (this: ChatViewProvider, tab: Tab) {
    if (!this.tabs.has(tab)) {
      return;
    }
    yield* thenable(() => vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`));
    if (this.tabs.active !== tab) {
      yield* this.selectTab(tab);
    }
  });

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
    this.attention.refresh();
    this.saveTabs();
  }

  private postFolders(): void {
    this.post({ type: "folders", folders: workspaceFolders() });
  }

  /** The file "include open file" would send, shown beside the checkbox. */
  private postActiveFile(): void {
    this.post({ type: "activeFile", name: activeFileName() });
  }

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

  /** Shows the saved usage of the tab's session (or the one it will reopen) until the agent reports again. */
  private postSavedUsage(tab: Tab): void {
    const sessionId = tab.sessionId ?? tab.reopen?.sessionId;
    const usage = sessionId === undefined ? undefined : usageOf(tab, sessionId);
    if (!usage) {
      return;
    }
    const { compactAt, ...reported } = usage;
    this.postTab(tab, { type: "update", update: { sessionUpdate: "usage_update", ...reported } });
    this.postTab(tab, { type: "compactWindow", size: compactAt ?? null });
    this.run(this.postSessionTotals(tab), tab);
  }

  /** The ledger entry of a tab's session; undefined until it has one and knows its agent. */
  private sessionRef(tab: Tab, sessionId: string | undefined = tab.sessionId): SessionRef | undefined {
    const agentId = tab.running?.agentId ?? tab.reopen?.agentId ?? tab.agentId;
    return agentId && sessionId ? { agentId, sessionId, cwd: tab.cwd, title: tab.name ?? tab.title } : undefined;
  }

  /** The tokens and cost recorded for the tab's session, shown with its context usage. */
  private readonly postSessionTotals = Effect.fn("ChatView.postSessionTotals")(function* (this: ChatViewProvider, tab: Tab) {
    const ref = this.sessionRef(tab, tab.sessionId ?? tab.reopen?.sessionId);
    const totals = ref ? yield* (yield* UsageLedger).session(ref.agentId, ref.sessionId) : undefined;
    this.postTab(tab, { type: "sessionTotals", totals: totals ?? null });
  });

  private tabOf(msg: FromWebview): Tab | undefined {
    return "tab" in msg ? this.tabs.byId(msg.tab) : undefined;
  }

  private readonly onMessage = Effect.fn("ChatView.onMessage")(function* (this: ChatViewProvider, msg: FromWebview) {
    const tab = this.tabOf(msg);
    switch (msg.type) {
      case "ready":
        yield* this.drafts.load();
        this.post({ type: "environment", remote: vscode.env.remoteName !== undefined });
        this.postFolders();
        this.postActiveFile();
        this.postTabs();
        yield* this.postAgent;
        this.post({ type: "followAgent", enabled: this.followAgent });
        this.post({ type: "autoScroll", enabled: readSettings().autoScroll });
        for (const each of this.tabs.all) {
          this.refreshStatus(each);
          this.postSavedUsage(each);
          this.changes.postIfTracked(each);
          if (each.queue.length > 0) {
            this.postQueue(each);
          }
        }
        this.attachments.flush();
        yield* this.ensureSession(this.tabs.active);
        break;
      case "send":
        if (tab) {
          const message: OutgoingMessage = { parts: msg.parts, includeActiveFile: msg.includeActiveFile };
          if (msg.rewind !== undefined) {
            yield* this.resend(tab, msg.rewind, message, true);
          } else if (msg.now) {
            yield* this.sendNow(tab, message);
          } else {
            yield* this.send(tab, message);
          }
        }
        break;
      case "sendQueuedNow":
        if (tab) {
          yield* this.sendQueuedNow(tab, msg.id);
        }
        break;
      case "unqueue":
        if (tab) {
          this.unqueue(tab, msg.id, msg.edit);
        }
        break;
      case "editMessage":
        if (tab) {
          this.editMessage(tab, msg.turn);
        }
        break;
      case "retry": {
        const sent = tab?.sent.get(msg.turn);
        if (tab && sent) {
          yield* this.resend(tab, msg.turn, sent, false);
        } else if (tab) {
          this.postTab(tab, { type: "notice", key: "chat.cannotEdit" });
        }
        break;
      }
      case "fork":
        if (tab) {
          yield* this.fork(tab, msg.turn);
        }
        break;
      case "cancel":
        if (tab) {
          yield* this.cancelTab(tab);
        }
        break;
      case "draft":
        if (tab) {
          yield* this.setDraft(tab, msg.draft);
        }
        break;
      case "draftText":
        if (tab) {
          yield* this.setDraft(tab, msg.text);
        }
        break;
      case "newTab":
        yield* this.newSession();
        break;
      case "selectTab":
        if (tab) {
          yield* this.selectTab(tab);
        }
        break;
      case "closeTab":
        if (tab) {
          yield* this.closeTab(tab);
          yield* this.drafts.prune;
        }
        break;
      case "pinTab":
        if (tab && this.tabs.pin(tab, msg.pinned)) {
          this.postTabs();
        }
        break;
      case "renameTab":
        if (tab && this.tabs.rename(tab, msg.title)) {
          this.postTabs();
        }
        break;
      case "moveTab":
        if (tab && this.tabs.move(tab, msg.index)) {
          this.postTabs();
        }
        break;
      case "history":
        yield* this.showHistory();
        break;
      case "openSession":
        yield* this.openSession(msg.sessionId, msg.cwd, msg.title);
        break;
      case "login":
        yield* this.login();
        break;
      case "selectAgent":
        yield* thenable(() => vscode.commands.executeCommand("codeAcp.selectAgent"));
        break;
      case "setAgent":
        if (tab) {
          yield* this.setTabAgent(tab, msg.id);
        }
        break;
      case "setCwd":
        if (tab) {
          yield* this.setTabCwd(tab, msg.cwd);
        }
        break;
      case "manageAgents":
        yield* thenable(() => vscode.commands.executeCommand("codeAcp.manageAgents"));
        break;
      case "showUsage":
        yield* thenable(() => vscode.commands.executeCommand("codeAcp.showUsage"));
        break;
      case "updateAgent": {
        const update = (yield* this.updates.pending).find((u) => u.installed.id === msg.id);
        if (update) {
          yield* this.updateAgents([update]);
        }
        break;
      }
      case "permission":
        this.permissions.answer(msg.id, msg.optionId);
        break;
      case "setConfig":
        if (tab?.running && tab.sessionId) {
          const res = yield* tab.running.agent.setConfigOption(tab.sessionId, msg.configId, msg.value);
          this.postTab(tab, { type: "configOptions", configOptions: res.configOptions });
        }
        break;
      case "openFile":
        yield* this.openFile(msg.path, msg.line);
        break;
      case "openImage": {
        const file = yield* imageToTempFile(msg.src, msg.name);
        if (file) {
          yield* thenable(() => vscode.commands.executeCommand("vscode.open", vscode.Uri.file(file)));
          yield* thenable(() => vscode.commands.executeCommand("workbench.action.moveEditorToNewWindow"));
        }
        break;
      }
      case "searchFiles": {
        const completions = yield* Completions;
        // A failed search offers nothing rather than an error in the chat.
        const files = yield* completions.files(msg.query).pipe(
          Effect.tapError((err) => Effect.logWarning(`File search failed: ${err.message}`)),
          Effect.orElseSucceed(() => []),
        );
        const terminals = yield* (yield* TerminalContext).suggestions(msg.query);
        const problems = yield* (yield* Problems).suggestions(msg.query);
        this.post({ type: "files", id: msg.id, files, terminals, problems });
        break;
      }
      case "attachProblems": {
        const attachment = yield* (yield* Problems).attachment(msg.scope);
        if (Option.isSome(attachment)) {
          this.attachments.add([attachment.value]);
        }
        break;
      }
      case "attachTerminal": {
        const attachment = yield* (yield* TerminalContext).command(msg.id);
        if (Option.isSome(attachment)) {
          this.attachments.add([attachment.value]);
        }
        break;
      }
      case "listSkills":
        this.post({ type: "skills", skills: yield* (yield* Completions).skills });
        break;
      case "killTerminal":
        if (tab?.running && tab.sessionId) {
          yield* tab.running.agent.killTerminal(tab.sessionId, msg.terminalId);
        }
        break;
      case "openDiff":
        if (tab) {
          yield* this.changes.openDiff(tab, msg.path, msg.oldText, msg.newText);
        }
        break;
      case "keepChanges":
        if (tab) {
          yield* this.changes.keep(tab, msg.path);
        }
        break;
      case "undoChanges":
        if (tab) {
          yield* this.changes.undo(tab, msg.path);
        }
        break;
      case "restoreCheckpoint":
        if (tab) {
          yield* this.changes.restore(tab, msg.turn);
        }
        break;
      case "setFollowAgent":
        yield* thenable(() =>
          vscode.workspace.getConfiguration("codeAcp").update("followAgent", msg.enabled, vscode.ConfigurationTarget.Global),
        );
        break;
      case "setAutoScroll":
        yield* thenable(() =>
          vscode.workspace.getConfiguration("codeAcp").update("autoScroll", msg.enabled, vscode.ConfigurationTarget.Global),
        );
        break;
    }
  });

  /**
   * Opens a file in an editor (at `line` when given) or reveals a folder in the Explorer. Relative paths come
   * from the shown conversation, so they start at the active tab's folder. A relative path missing there (agents
   * often write a bare `protocol.ts`) is looked up in the workspace; several matches are offered in a pick.
   */
  private readonly openFile = Effect.fn("ChatView.openFile")(function* (
    this: ChatViewProvider,
    file: string,
    line: number | undefined,
  ) {
    let uri = vscode.Uri.file(resolvePath(file, this.tabs.active.cwd));
    let stat = yield* thenable(() => vscode.workspace.fs.stat(uri)).pipe(Effect.option);
    if (Option.isNone(stat) && !path.isAbsolute(file) && !file.startsWith("~/")) {
      const found = yield* this.findInWorkspace(file);
      if (found) {
        uri = found;
        stat = yield* thenable(() => vscode.workspace.fs.stat(uri)).pipe(Effect.option);
      } else if (found === null) {
        return;
      }
    }
    if (Option.isNone(stat)) {
      vscode.window.setStatusBarMessage(t("chat.fileNotFound", file), 4000);
      return;
    }
    if (stat.value.type & vscode.FileType.Directory) {
      yield* thenable(() => vscode.commands.executeCommand("revealInExplorer", uri));
      return;
    }
    const position = line ? new vscode.Position(line - 1, 0) : undefined;
    // `vscode.open` picks the editor by file type, so images and other binaries open in their viewer.
    const options: vscode.TextDocumentShowOptions = position ? { selection: new vscode.Range(position, position) } : {};
    yield* thenable(() => vscode.commands.executeCommand("vscode.open", uri, options));
  });

  /** Workspace files ending in `file`, git-ignored ones left out: the only match, the picked one, `null` if the pick was dismissed. */
  private readonly findInWorkspace = Effect.fn("ChatView.findInWorkspace")(function* (file: string) {
    const name = file.replace(/^\.\//, "").replace(/\/$/, "");
    if (!name || name.split("/").includes("..")) {
      return undefined;
    }
    // Brackets and braces in a name are glob syntax; `[x]` matches the character itself.
    const glob = `**/${name.replace(/[[\]{}]/g, "[$&]")}`;
    const found = yield* thenable(() => vscode.workspace.findFiles(glob, excludeGlob(), 50));
    // Build output and other ignored files only when nothing else matches.
    const ignored = yield* gitIgnored(found);
    const kept = found.filter((uri) => !ignored.has(uri.fsPath));
    const uris = kept.length > 0 ? kept : found;
    if (uris.length <= 1) {
      return uris[0];
    }
    const items = uris
      .map((uri) => ({ label: vscode.workspace.asRelativePath(uri), uri }))
      .sort((a, b) => a.label.length - b.label.length || a.label.localeCompare(b.label));
    const picked = yield* thenable(() => vscode.window.showQuickPick(items, { title: t("chat.pickFile", name) }));
    return picked?.uri ?? null;
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
      replay.turn = this.nextTurn++;
      replay.turns.push(replay.turn);
    }
    replay.blocks.push(update.content);
    tab.sent.set(replay.turn, { parts: replayedParts(replay.blocks), includeActiveFile: false });
    return replay.turn;
  }

  private onSessionUpdate(tab: Tab, n: acp.SessionNotification): void {
    const { update } = n;
    if (update.sessionUpdate === "session_info_update" && update.title !== undefined) {
      tab.title = update.title ?? undefined;
      this.postTabs();
    }
    this.postTab(tab, { type: "update", update, turn: this.replayTurn(tab, update) });
    if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      this.follower.toolCall(tab, update);
      // The tool may have changed files, however it did.
      if (update.status === "completed" || update.status === "failed") {
        this.changes.post(tab);
      }
    }
    if (update.sessionUpdate === "usage_update") {
      const { used, size, cost } = update;
      const ref = this.sessionRef(tab, n.sessionId);
      if (cost && ref) {
        // Read before it is replaced: a reopened session's last cost is not new spending.
        const previous = usageOf(tab, n.sessionId)?.cost ?? undefined;
        this.run(
          UsageLedger.use((ledger) => ledger.recordCost(ref, cost, previous)).pipe(Effect.andThen(this.postSessionTotals(tab))),
          tab,
        );
      }
      const compactAt = tab.usageSessionId === n.sessionId ? tab.usage?.compactAt : undefined;
      tab.usage = { used, size, cost, compactAt };
      tab.usageSessionId = n.sessionId;
      this.saveTabs();
      this.postCompactWindow(tab, update);
    }
  }

  /**
   * Claude agents name the model in `_meta`, but report its full window as `size`; Claude Code
   * compacts earlier when `autoCompactWindow` is set, so the meter also shows that limit.
   */
  private postCompactWindow(tab: Tab, update: acp.UsageUpdate): void {
    const model = update._meta?.[CLAUDE_MODEL_META];
    if (!Predicate.isString(model)) {
      return;
    }
    this.run(
      Effect.gen({ self: this }, function* () {
        const window = yield* (yield* ClaudeSettings).autoCompactWindow(model, tab.cwd);
        if (tab.usage) {
          tab.usage = { ...tab.usage, compactAt: Option.getOrUndefined(window) };
          this.saveTabs();
        }
        this.postTab(tab, { type: "compactWindow", size: Option.getOrNull(window) });
      }),
      tab,
    );
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
      tab.busy = false;
      // The queue waits for the user rather than starting the agent again.
      tab.steer = false;
      this.status(tab, "chat.stopped", { stopped: true });
    }
    this.postTabs();
    // A separate fiber: this one runs inside the scope being closed.
    this.runtime.runFork(Scope.close(running.scope, Exit.void));
  }

  private readonly createSession = Effect.fn("ChatView.createSession")(function* (this: ChatViewProvider, tab: Tab) {
    return yield* Semaphore.withPermits(
      tab.sessionLock,
      1,
    )(
      Effect.gen({ self: this }, function* () {
        if (tab.sessionId) {
          return tab.sessionId;
        }
        const running = yield* this.getAgent(tab);
        if (tab.reopen) {
          const reopened = yield* this.reopenSession(tab, running, tab.reopen);
          if (reopened) {
            return reopened;
          }
        }
        // A folder removed from the workspace, or the folder of a past session outside it: start in the workspace.
        if (folderOf(tab.cwd) === undefined) {
          tab.cwd = defaultCwd();
          this.postTabs();
        }
        const cwd = tab.cwd;
        const res = yield* running.agent.newSession(cwd);
        if (!this.tabs.has(tab) || tab.cwd !== cwd || tab.agentId !== running.agentId) {
          // Closed, or moved to another folder or agent, while the session was starting.
          yield* this.closeSessionOnAgent(running, res.sessionId);
          return res.sessionId;
        }
        tab.sessionId = res.sessionId;
        tab.running = running;
        this.postTabs();
        this.postTab(tab, { type: "session", sessionId: res.sessionId, configOptions: res.configOptions });
        this.status(tab, "chat.ready");
        return res.sessionId;
      }),
    );
  });

  /** Reopens a saved session in its tab; undefined when it can't be, and the tab should start over. */
  private readonly reopenSession = Effect.fn("ChatView.reopenSession")(function* (
    this: ChatViewProvider,
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
            this.postTab(tab, { type: "notice", key: "chat.reopenFailed" });
            return false;
          }),
        ),
      );
      if (opened) {
        tab.reopen = undefined;
        this.saveTabs();
        return reopen.sessionId;
      }
    }
    tab.reopen = undefined;
    tab.title = undefined;
    tab.createdAt = undefined;
    tab.used = false;
    this.postTabs();
    return undefined;
  });

  /**
   * Shows a past session in `tab`, replaying its history when the agent supports session/load. The tab's checkpoints
   * stay: callers showing another session clear them first.
   */
  private readonly loadInto = Effect.fn("ChatView.loadInto")(function* (
    this: ChatViewProvider,
    tab: Tab,
    running: RunningAgent,
    sessionId: string,
    cwd: string,
  ) {
    const { agent } = running;
    const caps = agent.initializeResponse.agentCapabilities;
    this.postTab(tab, { type: "reset" });
    tab.sent.clear();
    const previousCwd = tab.cwd;
    // Set first: the replayed updates are only forwarded for a tab's session.
    tab.sessionId = sessionId;
    tab.running = running;
    tab.cwd = cwd;
    tab.used = true;
    tab.busy = true;
    this.status(tab, "chat.loadingSession");
    this.postTabs();
    const res = yield* (
      caps?.loadSession
        ? Effect.suspend(() => {
            const replaying = (tab.replaying = { blocks: [], turns: [] });
            return agent.loadSession(sessionId, cwd).pipe(Effect.tap(() => Effect.sync(() => this.changes.matchReplay(tab, replaying.turns))));
          }).pipe(Effect.ensuring(Effect.sync(() => void (tab.replaying = undefined))))
        : agent.resumeSession(sessionId, cwd).pipe(
            Effect.tap(() => Effect.sync(() => this.postTab(tab, { type: "notice", key: "chat.resumedNoHistory" }))),
          )
    ).pipe(
      Effect.tapError(() =>
        Effect.sync(() => {
          tab.sessionId = undefined;
          tab.running = undefined;
          tab.cwd = previousCwd;
          this.postTabs();
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          tab.busy = false;
          this.refreshStatus(tab);
        }),
      ),
    );
    this.postTab(tab, { type: "session", sessionId, configOptions: res.configOptions });
    this.postSavedUsage(tab);
    this.status(tab, "chat.ready");
    // Messages sent while the session loaded.
    this.sendQueued(tab);
  });

  /** The tab's session, created when missing; undefined when the user has to act first. */
  private ensureSession(tab: Tab): Effect.Effect<string | undefined, AgentStartError | AgentRequestError, Output | ExtensionCtx> {
    return this.createSession(tab).pipe(
      Effect.catchTags({
        NoAgentError: () => Effect.sync(() => void this.status(tab, "chat.noAgent", { needsAgent: true })),
        AuthRequiredError: () => Effect.sync(() => void this.status(tab, "chat.needsLogin", { needsLogin: true })),
      }),
    );
  }

  /** Frees a session the chat no longer shows, when the agent supports session/close. */
  private closeSessionOnAgent(running: RunningAgent | undefined, sessionId: string): Effect.Effect<void> {
    const agent = running?.agent;
    if (!agent?.initializeResponse.agentCapabilities?.sessionCapabilities?.close) {
      return Effect.void;
    }
    return agent.closeSession(sessionId).pipe(Effect.ignore);
  }

  /** Stops agent processes that no tab uses any more, nor is about to start a session on. */
  private get stopIdleAgents(): Effect.Effect<void> {
    return this.agents.stopIdle((running) =>
      this.tabs.all.some((tab) => tab.running === running || (!tab.running && tab.agentId === running.agentId)),
    );
  }

  /** Ends the tab's conversation so it starts over in a fresh session, e.g. on another agent or in another folder. */
  private readonly startOver = Effect.fn("ChatView.startOver")(function* (this: ChatViewProvider, tab: Tab, change: (tab: Tab) => void) {
    if (tab.busy) {
      yield* this.cancelTab(tab).pipe(Effect.ignore);
    }
    this.permissions.cancel(tab);
    if (tab.sessionId) {
      yield* this.closeSessionOnAgent(tab.running, tab.sessionId);
    }
    resetConversation(tab);
    tab.usage = undefined;
    tab.usageSessionId = undefined;
    change(tab);
    this.postTab(tab, { type: "reset" });
    this.changes.clear(tab);
    this.postTabs();
    yield* this.stopIdleAgents;
    yield* this.ensureSession(tab);
  });

  /**
   * Asks before a start over ends a conversation (and stops a running turn); an unused tab has none to lose.
   * When the user says no, the pickers go back to the tab's agent and folder.
   */
  private readonly confirmStartOver = Effect.fn("ChatView.confirmStartOver")(function* (this: ChatViewProvider, tab: Tab) {
    if (!tab.used && !tab.busy) {
      return true;
    }
    const ok = yield* confirm(t(tab.busy ? "chat.startOverBusyConfirm" : "chat.startOverConfirm"), t("chat.startOver"));
    if (!ok) {
      this.postTabs();
    }
    return ok && this.tabs.has(tab);
  });

  /** Switches `tab` to another agent, starting over in a fresh session; it also becomes the default for new tabs. */
  private readonly setTabAgent = Effect.fn("ChatView.setTabAgent")(function* (
    this: ChatViewProvider,
    tab: Tab,
    agentId: string,
  ) {
    const change = tab.agentId !== agentId;
    if (change && !(yield* this.confirmStartOver(tab))) {
      return;
    }
    yield* this.manager.setActive(agentId);
    if (change) {
      yield* this.startOver(tab, (tab) => (tab.agentId = agentId));
    }
  });

  /** Moves `tab` to another workspace folder, starting over in a fresh session there. */
  private readonly setTabCwd = Effect.fn("ChatView.setTabCwd")(function* (this: ChatViewProvider, tab: Tab, cwd: string) {
    if (tab.cwd !== cwd && isWorkspaceFolder(cwd) && (yield* this.confirmStartOver(tab))) {
      yield* this.startOver(tab, (tab) => (tab.cwd = cwd));
    }
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
    const tab = this.tabs.add(cwdForNewTab(this.tabs.length ? this.tabs.active.cwd : undefined));
    tab.agentId = yield* this.manager.activeId;
    this.tabs.active = tab;
    this.postTabs();
    yield* thenable(() => vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`));
    this.post({ type: "focusComposer" });
    yield* this.ensureSession(tab);
  });

  private readonly selectTab = Effect.fn("ChatView.selectTab")(function* (this: ChatViewProvider, tab: Tab) {
    this.tabs.active = tab;
    this.postTabs();
    if (!tab.busy) {
      yield* this.ensureSession(tab);
    }
  });

  private readonly closeTab = Effect.fn("ChatView.closeTab")(function* (this: ChatViewProvider, tab: Tab) {
    if (!this.tabs.has(tab)) {
      return;
    }
    if (tab.busy) {
      yield* this.cancelTab(tab).pipe(Effect.ignore);
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
      yield* this.closeSessionOnAgent(tab.running, tab.sessionId);
    }
    yield* this.stopIdleAgents;
    if (this.tabs.length === 0) {
      yield* this.newSession();
      return;
    }
    if (this.tabs.active === tab) {
      this.tabs.active = this.tabs.at(Math.min(index, this.tabs.length - 1))!;
    }
    this.postTabs();
    yield* this.ensureSession(this.tabs.active);
  });

  /** Shows the active tab's agent's past sessions in the workspace folders, in the chat view. */
  readonly showHistory = Effect.fn("ChatView.showHistory")(function* (this: ChatViewProvider) {
    yield* thenable(() => vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`));
    const latest = this.history.next();
    const post = (message: object) => {
      if (latest()) {
        this.post({ type: "history", ...message });
      }
    };
    post({ loading: true, sessions: [] });
    const running = yield* this.getAgent(this.tabs.active).pipe(Effect.catchTag("NoAgentError", () => Effect.undefined));
    const folders = new Set([...workspaceFolders().map((f) => f.path), this.tabs.active.cwd]);
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

  /**
   * Shows a past session: switches to its tab when it is open, else loads it into the active tab when that is
   * unused, else into a new tab. History is replayed when the agent supports session/load.
   */
  private readonly openSession = Effect.fn("ChatView.openSession")(function* (
    this: ChatViewProvider,
    sessionId: string,
    cwd: string,
    title: string | undefined,
  ) {
    const open = this.tabs.showing(sessionId);
    if (open) {
      yield* this.selectTab(open);
      return;
    }
    // The history lists the active tab's agent's sessions.
    const from = this.tabs.active;
    const running = yield* this.getAgent(from);
    const reuse = !from.used && !from.busy;
    const tab = reuse ? from : this.tabs.add(cwd);
    const replaced = tab.sessionId;
    const replacedOn = tab.running;
    this.tabs.active = tab;
    tab.agentId = from.agentId;
    tab.title = title?.trim() || undefined;
    tab.createdAt = undefined;
    tab.reopen = undefined;
    this.postTabs();
    if (replaced) {
      yield* this.closeSessionOnAgent(replacedOn, replaced);
    }
    this.changes.clear(tab);
    yield* this.loadInto(tab, running, sessionId, cwd).pipe(
      // Fall back to a fresh session so the tab stays usable.
      Effect.tapError(() => this.ensureSession(tab)),
    );
    this.saveTabs();
  });

  /** Sends a message, or queues it while the tab is busy with a turn; queued ones follow when a turn ends. */
  private readonly send = Effect.fn("ChatView.send")(function* (this: ChatViewProvider, tab: Tab, message: OutgoingMessage) {
    if (message.parts.every((part) => typeof part === "string" && !part.trim())) {
      return;
    }
    if (tab.busy || tab.sending) {
      tab.queue.push({ ...message, id: this.nextQueued++ });
      this.postQueue(tab);
      return;
    }
    tab.sending = true;
    yield* this.sendTurn(tab, message).pipe(
      Effect.ensuring(Effect.sync(() => (tab.sending = false))),
      Effect.onExit((exit) =>
        Effect.sync(() => {
          const stopReason = Exit.isSuccess(exit) ? exit.value : undefined;
          // A turn the user stopped needs no word; one the queue follows is not the end yet.
          if (stopReason && stopReason !== "cancelled" && !(stopReason === "end_turn" && tab.queue.length) && this.tabs.has(tab)) {
            this.attention.raise(tab, "finished");
          }
          // The queue waits while the user looks at a turn they stopped, or that failed.
          if (tab.steer || stopReason === "end_turn") {
            this.sendQueued(tab);
          }
        }),
      ),
    );
  });

  /** Sends the first queued message, when the tab is idle. */
  private sendQueued(tab: Tab): void {
    tab.steer = false;
    if (!this.tabs.has(tab) || tab.busy || tab.sending) {
      return;
    }
    const next = tab.queue.shift();
    if (next) {
      this.postQueue(tab);
      this.run(this.send(tab, next), tab);
    }
  }

  private postQueue(tab: Tab): void {
    const items: QueuedInfo[] = tab.queue.map(({ id, parts }) => ({
      id,
      text: messageText(parts),
      attachments: parts.flatMap((part) => (typeof part !== "string" && !part.token ? [part.name] : [])),
    }));
    this.postTab(tab, { type: "queue", items });
  }

  /** Sends a message right away: a running turn is stopped, and the message goes first once it has. */
  private readonly sendNow = Effect.fn("ChatView.sendNow")(function* (this: ChatViewProvider, tab: Tab, message: OutgoingMessage) {
    if (!tab.busy && !tab.sending) {
      return yield* this.send(tab, message);
    }
    tab.queue.unshift({ ...message, id: this.nextQueued++ });
    this.postQueue(tab);
    yield* this.steer(tab);
  });

  /** Moves a queued message first and sends it, stopping the running turn. */
  private readonly sendQueuedNow = Effect.fn("ChatView.sendQueuedNow")(function* (this: ChatViewProvider, tab: Tab, id: number) {
    const index = tab.queue.findIndex((each) => each.id === id);
    if (index < 0) {
      return;
    }
    tab.queue.unshift(...tab.queue.splice(index, 1));
    this.postQueue(tab);
    if (tab.busy) {
      yield* this.steer(tab);
    } else {
      this.sendQueued(tab);
    }
  });

  /** Stops the running turn so the first queued message goes next. */
  private readonly steer = Effect.fn("ChatView.steer")(function* (this: ChatViewProvider, tab: Tab) {
    // Still preparing its prompt: the queue follows once that turn ends.
    if (tab.busy) {
      tab.steer = true;
      yield* this.cancelTab(tab);
    }
  });

  /** Takes a message out of the queue, back to the composer when it is to be edited. */
  private unqueue(tab: Tab, id: number, edit: boolean): void {
    const index = tab.queue.findIndex((each) => each.id === id);
    if (index < 0) {
      return;
    }
    const [message] = tab.queue.splice(index, 1);
    this.postQueue(tab);
    if (edit && message) {
      this.loadComposer(tab, { parts: [...message.parts] });
    }
  }

  private loadComposer(tab: Tab, load: LoadComposer): void {
    this.postTab(tab, { type: "loadComposer", ...load });
  }

  /** Puts a sent message back in the composer, to change it and send it in place of the original. */
  private editMessage(tab: Tab, turn: number): void {
    const sent = tab.sent.get(turn);
    if (!sent) {
      this.postTab(tab, { type: "notice", key: "chat.cannotEdit" });
      return;
    }
    this.loadComposer(tab, { parts: [...sent.parts], rewind: turn });
  }

  /**
   * Takes back the user message of `turn` and the rest of the conversation, then sends `message` in its place.
   * The agent can't forget, so the prompt tells it what was taken back. An edit the user cancels goes back to
   * the composer.
   */
  private readonly resend = Effect.fn("ChatView.resend")(function* (
    this: ChatViewProvider,
    tab: Tab,
    turn: number,
    message: OutgoingMessage,
    edited: boolean,
  ) {
    const giveBack = () => {
      if (edited) {
        this.loadComposer(tab, { parts: [...message.parts], rewind: turn });
      }
    };
    if (!tab.sent.has(turn)) {
      this.postTab(tab, { type: "notice", key: "chat.cannotEdit" });
      return;
    }
    if (tab.busy || tab.sending) {
      void vscode.window.showInformationMessage(t("chat.rewindBusy"));
      return giveBack();
    }
    // The dialog leaves time to start another turn.
    if (!(yield* this.changes.rewind(tab, turn)) || tab.busy || tab.sending || !tab.sent.has(turn)) {
      return giveBack();
    }
    this.rewindTo(tab, turn);
    yield* this.send(tab, message);
  });

  /** Drops the user message of `turn` and what followed from the chat, and tells the agent with the next prompt. */
  private rewindTo(tab: Tab, turn: number): void {
    const original = tab.sent.get(turn);
    const line = original ? messageText(original.parts).trim().split("\n")[0]! : "";
    const excerpt = line.length > MAX_EXCERPT_LENGTH ? `${line.slice(0, MAX_EXCERPT_LENGTH - 1)}…` : line;
    for (const each of [...tab.sent.keys()]) {
      if (each >= turn) {
        tab.sent.delete(each);
      }
    }
    // Their messages are gone; the next turn takes a checkpoint of its own.
    tab.changes.checkpoints = tab.changes.checkpoints.filter((c) => c.turn < turn);
    this.saveTabs();
    this.changes.post(tab);
    tab.rewindNote = `[Note from the editor: the user went back in the conversation and took back their message "${excerpt}" and everything after it. Disregard that message, your replies to it and any later messages, as if they had never been sent, and continue from the message below.]`;
    this.postTab(tab, { type: "rewind", turn });
  }

  /**
   * Copies the conversation into a new tab next to `tab`, on a fork of its session (session/fork). With `turn`, the
   * fork goes back to before that user message, which waits in its composer.
   */
  private readonly fork = Effect.fn("ChatView.fork")(function* (this: ChatViewProvider, tab: Tab, turn: number | undefined) {
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
      this.postTab(tab, { type: "notice", key: "chat.cannotEdit" });
      return;
    }
    const res = yield* running.agent.forkSession(sessionId, tab.cwd);
    if (!this.tabs.has(tab) || !this.agents.isCurrent(running)) {
      // Closed, or its agent stopped, while forking.
      yield* this.closeSessionOnAgent(running, res.sessionId);
      return;
    }
    const fork = this.tabs.add(tab.cwd);
    this.tabs.move(fork, this.tabs.indexOf(tab) + 1);
    fork.agentId = running.agentId;
    fork.running = running;
    fork.sessionId = res.sessionId;
    fork.used = true;
    fork.title = t("chat.forkTitle", tab.name || tab.title || t("chat.untitled"));
    fork.createdAt = Date.now();
    fork.changes = ChangeSet.fromSaved(tab.changes.saved);
    fork.sent = new Map(tab.sent);
    fork.rewindNote = tab.rewindNote;
    if (tab.usage) {
      fork.usage = tab.usage;
      fork.usageSessionId = res.sessionId;
    }
    this.tabs.active = fork;
    this.postTabs();
    this.postTab(fork, { type: "forked", from: tab.id });
    this.postTab(fork, { type: "session", sessionId: res.sessionId, configOptions: res.configOptions });
    this.postSavedUsage(fork);
    this.changes.postIfTracked(fork);
    this.status(fork, "chat.ready");
    if (turn !== undefined && original) {
      this.rewindTo(fork, turn);
      this.loadComposer(fork, { parts: [...original.parts] });
    }
  });

  /** Runs a turn; its stop reason, or undefined when it could not start. */
  private readonly sendTurn = Effect.fn("ChatView.sendTurn")(function* (
    this: ChatViewProvider,
    tab: Tab,
    message: OutgoingMessage,
  ) {
    const { parts, includeActiveFile } = message;
    const text = messageText(parts);
    const sessionId = yield* this.ensureSession(tab);
    const agent = tab.running?.agent;
    if (!sessionId || !agent) {
      return;
    }
    const caps = agent.initializeResponse.agentCapabilities?.promptCapabilities ?? {};
    const prompt: Array<acp.ContentBlock> = [];
    const sent: Array<SentAttachment> = [];
    for (const attachment of parts) {
      if (typeof attachment === "string") {
        if (attachment.trim()) {
          prompt.push({ type: "text", text: attachment });
        }
        continue;
      }
      const block = yield* attachmentBlock(caps, attachment).pipe(
        Effect.catch((err) =>
          Effect.sync(() => {
            this.postTab(tab, { type: "error", text: t("chat.attachFailed", attachment.name, err.message) });
            return undefined;
          }),
        ),
      );
      sent.push({
        name: attachment.name,
        token: attachment.token,
        src: block?.type === "image" ? `data:${block.mimeType};base64,${block.data}` : undefined,
      });
      if (block) {
        prompt.push(block);
      }
    }
    if (prompt.length === 0) {
      return;
    }
    if (includeActiveFile) {
      prompt.push(...activeFileBlocks());
    }

    tab.used = true;
    tab.createdAt ??= Date.now();
    if (!tab.title) {
      const firstLine = text.trim().split("\n")[0] || sent[0]?.name || "";
      tab.title = firstLine.length > MAX_TITLE_LENGTH ? `${firstLine.slice(0, MAX_TITLE_LENGTH - 1)}…` : firstLine;
    }
    this.postTabs();
    const turn = this.nextTurn++;
    tab.turn = turn;
    tab.sent.set(turn, message);
    yield* this.changes.beginTurn(tab, turn, text || sent[0]?.name || "");
    const notes = [tab.rewindNote, tab.changes.takeNote()].filter(Predicate.isString);
    tab.rewindNote = undefined;
    if (notes.length > 0) {
      prompt.unshift({ type: "text", text: notes.join("\n\n") });
    }
    this.postTab(tab, { type: "userMessage", text, attachments: sent, turn });
    tab.busy = true;
    this.status(tab, "chat.working");
    return yield* agent.prompt(sessionId, prompt).pipe(
      Effect.tap((res) => {
        const ref = this.sessionRef(tab, sessionId);
        // `usage` is unstable in ACP, so the stable PromptResponse leaves it out.
        const usage = Predicate.hasProperty(res, "usage") ? res.usage : undefined;
        return ref
          ? UsageLedger.use((ledger) => ledger.recordTurn(ref, usage)).pipe(Effect.andThen(this.postSessionTotals(tab)))
          : Effect.void;
      }),
      Effect.map((res) => {
        this.postTab(tab, { type: "turnEnd", stopReason: res.stopReason });
        return res.stopReason;
      }),
      Effect.catchTag("AuthRequiredError", () =>
        Effect.sync(() => {
          tab.sessionId = undefined;
          this.status(tab, "chat.needsLogin", { needsLogin: true });
          return undefined;
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          // A turn cancelled by a start over may end after the tab's next turn began.
          if (tab.turn !== turn) {
            return;
          }
          tab.busy = false;
          tab.turn = undefined;
          this.changes.post(tab);
          if (tab.sessionId) {
            this.status(tab, "chat.ready");
          } else {
            this.refreshStatus(tab);
          }
        }),
      ),
    );
  });

  /** Adds attachments to the composer and shows the chat. */
  private readonly queueAndFocus = Effect.fn("ChatView.queueAndFocus")(function* (this: ChatViewProvider, attachments: Attachment[]) {
    // Queued first: they reach the composer once the view shows, even if focusing fails.
    this.attachments.add(attachments);
    yield* thenable(() => vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`));
  });

  /** Adds files/folders to the composer (Explorer / editor tab context menu). */
  readonly attach = Effect.fn("ChatView.attach")(function* (this: ChatViewProvider, uris: ReadonlyArray<vscode.Uri>) {
    yield* this.queueAndFocus(uriAttachments(uris));
  });

  /** Adds the editor's non-empty selections to the composer as snippets (editor context menu). */
  readonly attachSelection = Effect.fn("ChatView.attachSelection")(function* (
    this: ChatViewProvider,
    editor: vscode.TextEditor,
  ) {
    yield* this.queueAndFocus(selectionAttachments(editor));
  });

  /** Adds the active terminal's selection to the composer (terminal context menu). */
  readonly attachTerminalSelection = Effect.fn("ChatView.attachTerminalSelection")(function* (this: ChatViewProvider) {
    const selection = yield* (yield* TerminalContext).selection;
    if (Option.isNone(selection)) {
      void vscode.window.showInformationMessage(t("terminal.noSelection"));
      return;
    }
    yield* this.queueAndFocus([selection.value]);
  });

  /**
   * Adds the output of the active terminal's last command, or last failed one, to the composer
   * (terminal context menu).
   */
  readonly attachTerminalOutput = Effect.fn("ChatView.attachTerminalOutput")(function* (this: ChatViewProvider, failed: boolean) {
    const terminal = vscode.window.activeTerminal;
    if (!terminal) {
      return;
    }
    const terminals = yield* TerminalContext;
    const command = yield* (failed ? terminals.lastFailed(terminal) : terminals.lastCommand(terminal));
    if (Option.isNone(command)) {
      const reason = !terminal.shellIntegration ? "terminal.noShellIntegration" : failed ? "terminal.noFailed" : "terminal.noCommands";
      void vscode.window.showInformationMessage(t(reason));
      return;
    }
    yield* this.queueAndFocus([command.value]);
  });

  /** Adds the problems of the active editor's file, or of the workspace, to the composer. */
  readonly attachProblems = Effect.fn("ChatView.attachProblems")(function* (this: ChatViewProvider, scope: ProblemScope) {
    const attachment = yield* (yield* Problems).attachment(scope);
    if (Option.isNone(attachment)) {
      void vscode.window.showInformationMessage(t(scope === "file" ? "problems.noneInFile" : "problems.none"));
      return;
    }
    yield* this.queueAndFocus([attachment.value]);
  });

  /** Adds problems and the code around them to the composer ("Fix with Code ACP" quick fix). */
  readonly fixProblems = Effect.fn("ChatView.fixProblems")(function* (
    this: ChatViewProvider,
    uri: vscode.Uri,
    diagnostics: ReadonlyArray<vscode.Diagnostic>,
  ) {
    const attachments = yield* (yield* Problems).forDiagnostics(uri, diagnostics);
    if (attachments.length) {
      yield* this.queueAndFocus(attachments);
    }
  });

  /** Runs a tab context menu action (webview context menu); pinned tabs are never closed. */
  readonly tabAction = Effect.fn("ChatView.tabAction")(function* (
    this: ChatViewProvider,
    id: number,
    action: "pin" | "unpin" | "rename" | "close" | "closeOthers" | "closeToRight" | "fork",
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
        yield* this.fork(tab, undefined);
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
    yield* this.cancelTab(this.tabs.active);
  });

  private readonly cancelTab = Effect.fn("ChatView.cancelTab")(function* (this: ChatViewProvider, tab: Tab) {
    // ACP: the client must answer pending permission requests with "cancelled" on cancel.
    this.permissions.cancel(tab);
    if (tab.running && tab.sessionId) {
      yield* tab.running.agent.cancel(tab.sessionId);
    }
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
      yield* this.ensureSession(this.tabs.active);
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
    yield* this.ensureSession(this.tabs.active);
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
