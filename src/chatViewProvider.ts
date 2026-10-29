import type * as acp from "@agentclientprotocol/sdk";
import { Clock, Deferred, Effect, Exit, FileSystem, Option, PlatformError, Predicate, Schema, Scope, Semaphore } from "effect";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { spawnAgent, type AcpAgent, type AgentCommand, type AgentRequestError, type AgentStartError } from "./acpClient";
import type { AgentManager } from "./agentManager";
import { ClaudeSettings } from "./claudeSettings";
import { onDidChangeLocale, t, webviewL10n, type MessageKey } from "./i18n";
import { runIn, thenable, type AppRuntime, type AppServices, type Output, type VscodeError } from "./runtime";
import { readSettings } from "./settings";
import { webviewHtml, webviewRoots } from "./webview";

export type FromWebview =
  | { type: "ready" }
  /** The composer in order: text runs and the attachments between them. */
  | { type: "send"; tab: number; parts: PromptPart[]; includeActiveFile: boolean }
  | { type: "cancel"; tab: number }
  | { type: "newTab" }
  | { type: "selectTab"; tab: number }
  | { type: "closeTab"; tab: number }
  | { type: "pinTab"; tab: number; pinned: boolean }
  /** `index` is the tab's position after the move; it stays inside its pinned or unpinned group. */
  | { type: "moveTab"; tab: number; index: number }
  | { type: "history" }
  | { type: "openSession"; sessionId: string; cwd: string; title?: string }
  | { type: "login" }
  | { type: "selectAgent" }
  | { type: "setAgent"; tab: number; id: string }
  | { type: "manageAgents" }
  | { type: "permission"; id: number; optionId: string | null }
  | { type: "setConfig"; tab: number; configId: string; value: string }
  /** A file path from agent output; relative paths resolve against the workspace. `line` is 1-based. */
  | { type: "openFile"; path: string; line?: number };

/** A chat tab as the webview shows it in the tab strip. */
export interface TabInfo {
  id: number;
  /** Undefined until the first message or the agent names the session. */
  title?: string;
  pinned: boolean;
  /** The installed agent picked for the tab; undefined until it has one. */
  agentId?: string;
}

/** Something dropped or pasted into the composer. */
export type Attachment =
  /** A file or folder the webview only knows by URI (VS Code explorer, editor tabs, uri-list). */
  | { kind: "uri"; uri: string; name: string }
  /** Raw bytes (OS drop or clipboard), base64-encoded. */
  | { kind: "data"; name: string; mimeType: string; data: string }
  /** Lines selected in an editor; `startLine`/`endLine` are 1-based and inclusive. */
  | { kind: "snippet"; uri: string; name: string; languageId: string; startLine: number; endLine: number; text: string };

/** A text run of the composer, or an attachment; inline ones carry the `token` that stands for them in the text. */
export type PromptPart = string | (Attachment & { token?: string });

/** An attachment as echoed in the sent message; `src` is a data URI when it went out as an image. */
export interface SentAttachment {
  name: string;
  src?: string;
  /** Set when the attachment sits inline in the message text. */
  token?: string;
}

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** Pages of `session/list` fetched for the history list. */
const MAX_HISTORY_PAGES = 5;

/** Text files up to this size are embedded when the agent supports embedded context. */
const MAX_EMBED_BYTES = 256 * 1024;

/** `_meta` key on Claude agents' `usage_update` naming the model the usage belongs to. */
const CLAUDE_MODEL_META = "_claude/model";

const CANCELLED: acp.RequestPermissionResponse = { outcome: { outcome: "cancelled" } };

function isTerminalAuth(m: acp.AuthMethod): m is acp.AuthMethodTerminal & { type: "terminal" } {
  return "type" in m && m.type === "terminal";
}

/** No agent installed or configured yet. */
class NoAgentError extends Schema.TaggedError<NoAgentError>()("NoAgentError", {}) {}

interface RunningAgent {
  readonly agent: AcpAgent;
  /** Owns the agent process; closing it kills the process. */
  readonly scope: Scope.Closeable;
  /** Id of the installed agent the process was started from (`CUSTOM_AGENT` for the setting). */
  readonly agentId: string;
}

/** A session to reopen when its tab is first used: saved before a reload, or lost when the agent exited. */
interface Reopen {
  readonly sessionId: string;
  readonly cwd: string;
  /** The agent the session belongs to; another agent can't open it. */
  readonly agentId: string | undefined;
}

/** Last context usage reported for a session; agents report none when a session is loaded. */
const SavedUsage = Schema.Struct({
  used: Schema.Finite,
  size: Schema.Finite,
  cost: Schema.optional(Schema.NullOr(Schema.Struct({ amount: Schema.Finite, currency: Schema.String }))),
  /** Auto-compact window, when the agent compacts before the end of `size`. */
  compactAt: Schema.optional(Schema.Finite),
});
type SavedUsage = typeof SavedUsage.Type;

const SavedTabs = Schema.Struct({
  active: Schema.Int,
  tabs: Schema.Array(
    Schema.Struct({
      title: Schema.optional(Schema.String),
      sessionId: Schema.optional(Schema.String),
      cwd: Schema.optional(Schema.String),
      agentId: Schema.optional(Schema.String),
      usage: Schema.optional(SavedUsage),
      pinned: Schema.optional(Schema.Boolean),
    }),
  ),
});
type SavedTabs = typeof SavedTabs.Type;

const TABS_KEY = "codeAcp.tabs";

/** Id of the codeAcp.agentCommand override among agent ids. */
const CUSTOM_AGENT = "custom";

/** One conversation: an ACP session on its agent's process; tabs on the same agent share the process. */
interface Tab {
  readonly id: number;
  title?: string;
  sessionId?: string;
  /** The process that owns `sessionId`. */
  running?: RunningAgent;
  /** Where the session runs; the workspace for new sessions. */
  cwd?: string;
  /** The installed agent picked for the tab; the codeAcp.agentCommand override wins over it. */
  agentId?: string;
  reopen?: Reopen;
  /** Last usage of the session `usageSessionId`, shown again when that session is reloaded. */
  usage?: SavedUsage;
  usageSessionId?: string;
  busy: boolean;
  /** Pinned tabs come first and have no close button. */
  pinned: boolean;
  /** Whether anything was sent or loaded; an unused tab is reused to open a past session. */
  used: boolean;
  /** Makes concurrent callers share one session start. */
  readonly sessionLock: Semaphore.Semaphore;
  /** Last status shown, re-posted in the new language when the locale changes. */
  lastStatus?: { key: MessageKey; extra: Record<string, unknown> };
}

interface PendingPermission {
  readonly tab: Tab;
  readonly answer: Deferred.Deferred<acp.RequestPermissionResponse>;
}

const MAX_TITLE_LENGTH = 40;

export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = "codeAcp.chat";

  private view?: vscode.WebviewView;
  /** Agent processes by agent id. */
  private readonly running = new Map<string, RunningAgent>();
  /** Makes concurrent callers share one agent start. */
  private readonly startLock = Semaphore.makeUnsafe(1);
  private nextTabId = 1;
  private readonly tabs: Tab[] = [];
  private active: Tab;
  private nextPermissionId = 1;
  private readonly pendingPermissions = new Map<number, PendingPermission>();
  /** Attachments added before the webview was ready; flushed on "ready". */
  private queuedAttachments: Attachment[] = [];
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly runtime: AppRuntime,
    private readonly manager: AgentManager["Service"],
  ) {
    this.active = this.restoreTabs();
    this.disposables.push(
      manager.onDidChange(() =>
        this.run(
          Effect.gen({ self: this }, function* () {
            yield* this.postAgent;
            // An uninstalled agent's tabs move to the default agent.
            for (const id of this.running.keys()) {
              if (id !== CUSTOM_AGENT && !(yield* this.manager.get(id))) {
                yield* this.restart(id);
              }
            }
          }),
        ),
      ),
      onDidChangeLocale(() => {
        this.post(webviewL10n());
        this.run(this.postAgent);
        for (const tab of this.tabs) {
          this.refreshStatus(tab);
        }
      }),
    );
  }

  /** Runs an effect from a VS Code callback, showing failures in the chat (in `tab`, else the active one). */
  private run<E>(effect: Effect.Effect<void, E, AppServices>, tab?: Tab): void {
    void runIn(this.runtime, effect, (text) => this.postTab(tab ?? this.active, { type: "error", text }));
  }

  /** The agent `tab` runs on: the override, else its pick while installed, else the default (last picked). */
  private readonly agentIdOf = Effect.fn("ChatView.agentIdOf")(function* (this: ChatViewProvider, tab: Tab) {
    if (this.customCommand()) {
      return CUSTOM_AGENT;
    }
    if (tab.agentId && (yield* this.manager.get(tab.agentId))) {
      return tab.agentId;
    }
    return yield* this.manager.activeId;
  });

  private customCommand(): AgentCommand | undefined {
    const { agentCommand, agentArgs, env } = readSettings();
    const command = agentCommand.trim();
    return command ? { command, args: agentArgs, env } : undefined;
  }

  /** Command to start the agent `agentId`, or undefined when it is not installed. */
  private readonly commandFor = Effect.fn("ChatView.commandFor")(function* (this: ChatViewProvider, agentId: string) {
    if (agentId === CUSTOM_AGENT) {
      return this.customCommand();
    }
    const agent = yield* this.manager.get(agentId);
    return agent ? this.manager.commandFor(agent) : undefined;
  });

  /** The composer's agent picker: installed agents, the default for new tabs, or the codeAcp.agentCommand override. */
  private get postAgent(): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const activeId = yield* this.manager.activeId;
      const agents = (yield* this.manager.list).map((a) => ({ id: a.id, name: `${a.name} ${a.version}` }));
      const custom = this.customCommand() ? t("chat.customAgent") : undefined;
      this.post({ type: "agent", agents, activeId, custom });
    });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const root = this.context.extensionUri;
    view.webview.options = { enableScripts: true, localResourceRoots: webviewRoots(root) };
    view.webview.html = webviewHtml(view.webview, root, "chat", `${view.webview.cspSource} data:`);
    view.webview.onDidReceiveMessage((msg: FromWebview) => this.run(this.onMessage(msg), this.tabOf(msg)));
    view.onDidDispose(() => (this.view = undefined));
  }

  private post(message: unknown): void {
    void this.view?.webview.postMessage(message);
  }

  /** Posts a message that belongs to one tab's conversation. */
  private postTab(tab: Tab, message: Record<string, unknown>): void {
    // A closed tab's turn may still be winding down.
    if (this.tabs.includes(tab)) {
      this.post({ ...message, tab: tab.id });
    }
  }

  private postTabs(): void {
    const tabs: TabInfo[] = this.tabs.map((tab) => ({
      id: tab.id,
      title: tab.title,
      pinned: tab.pinned,
      agentId: tab.agentId,
    }));
    this.post({ type: "tabs", tabs, active: this.active.id });
    this.saveTabs();
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

  /** Recreates the tabs saved for this workspace; their sessions reopen when each tab is first used. */
  private restoreTabs(): Tab {
    const saved = Option.getOrUndefined(
      Schema.decodeUnknownOption(SavedTabs)(this.context.workspaceState.get(TABS_KEY)),
    );
    for (const entry of saved?.tabs ?? []) {
      const tab = this.addTab();
      tab.pinned = entry.pinned ?? false;
      tab.agentId = entry.agentId === CUSTOM_AGENT ? undefined : entry.agentId;
      if (entry.sessionId) {
        tab.title = entry.title;
        tab.used = true;
        tab.reopen = { sessionId: entry.sessionId, cwd: entry.cwd ?? this.cwd(), agentId: entry.agentId };
        tab.usage = entry.usage;
        tab.usageSessionId = entry.sessionId;
      }
    }
    return this.tabs[saved?.active ?? 0] ?? this.tabs[0] ?? this.addTab();
  }

  /** Saves the tabs so they come back after a reload. */
  private saveTabs(): void {
    const value: SavedTabs = {
      active: this.tabs.indexOf(this.active),
      tabs: this.tabs.map((tab) => {
        const { pinned } = tab;
        // An unused tab's session is empty: a fresh one is just as good.
        if (tab.sessionId && tab.used) {
          const { sessionId } = tab;
          const cwd = tab.cwd ?? this.cwd();
          const agentId = tab.running?.agentId;
          return { title: tab.title, sessionId, cwd, agentId, usage: this.usageOf(tab, sessionId), pinned };
        }
        if (tab.reopen) {
          const { sessionId, cwd, agentId } = tab.reopen;
          return { title: tab.title, sessionId, cwd, agentId, usage: this.usageOf(tab, sessionId), pinned };
        }
        return { pinned, agentId: tab.agentId };
      }),
    };
    this.run(thenable(() => this.context.workspaceState.update(TABS_KEY, value)));
  }

  private usageOf(tab: Tab, sessionId: string): SavedUsage | undefined {
    return tab.usageSessionId === sessionId ? tab.usage : undefined;
  }

  /** Shows the saved usage of the tab's session (or the one it will reopen) until the agent reports again. */
  private postSavedUsage(tab: Tab): void {
    const sessionId = tab.sessionId ?? tab.reopen?.sessionId;
    const usage = sessionId === undefined ? undefined : this.usageOf(tab, sessionId);
    if (!usage) {
      return;
    }
    const { compactAt, ...reported } = usage;
    this.postTab(tab, { type: "update", update: { sessionUpdate: "usage_update", ...reported } });
    this.postTab(tab, { type: "compactWindow", size: compactAt ?? null });
  }

  private addTab(): Tab {
    const tab: Tab = { id: this.nextTabId++, busy: false, pinned: false, used: false, sessionLock: Semaphore.makeUnsafe(1) };
    this.tabs.push(tab);
    return tab;
  }

  /** Moves `tab` to `index`, kept inside its group: pinned tabs stay before the others. */
  private moveTab(tab: Tab, index: number): void {
    const from = this.tabs.indexOf(tab);
    if (from < 0) {
      return;
    }
    this.tabs.splice(from, 1);
    const pinnedCount = this.tabs.filter((each) => each.pinned).length;
    const [min, max] = tab.pinned ? [0, pinnedCount] : [pinnedCount, this.tabs.length];
    this.tabs.splice(Math.min(Math.max(index, min), max), 0, tab);
    this.postTabs();
  }

  private pinTab(tab: Tab, pinned: boolean): void {
    if (tab.pinned === pinned) {
      return;
    }
    tab.pinned = pinned;
    // Pinning appends to the pinned group; unpinning puts the tab first among the others.
    const pinnedCount = this.tabs.filter((each) => each.pinned && each !== tab).length;
    this.moveTab(tab, pinnedCount);
  }

  private tabById(id: number): Tab | undefined {
    return this.tabs.find((tab) => tab.id === id);
  }

  private tabOf(msg: FromWebview): Tab | undefined {
    return "tab" in msg ? this.tabById(msg.tab) : undefined;
  }

  private tabForSession(running: RunningAgent, sessionId: string): Tab | undefined {
    return this.tabs.find((tab) => tab.running === running && tab.sessionId === sessionId);
  }

  private readonly onMessage = Effect.fn("ChatView.onMessage")(function* (this: ChatViewProvider, msg: FromWebview) {
    const tab = this.tabOf(msg);
    switch (msg.type) {
      case "ready":
        this.postTabs();
        yield* this.postAgent;
        for (const each of this.tabs) {
          this.refreshStatus(each);
          this.postSavedUsage(each);
        }
        this.flushAttachments();
        yield* this.ensureSession(this.active);
        break;
      case "send":
        if (tab) {
          yield* this.send(tab, msg.parts, msg.includeActiveFile);
        }
        break;
      case "cancel":
        if (tab) {
          yield* this.cancelTab(tab);
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
        }
        break;
      case "pinTab":
        if (tab) {
          this.pinTab(tab, msg.pinned);
        }
        break;
      case "moveTab":
        if (tab) {
          this.moveTab(tab, msg.index);
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
      case "manageAgents":
        yield* thenable(() => vscode.commands.executeCommand("codeAcp.manageAgents"));
        break;
      case "permission":
        this.resolvePermission(
          msg.id,
          msg.optionId ? { outcome: { outcome: "selected", optionId: msg.optionId } } : CANCELLED,
        );
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
    }
  });

  /** Opens a file in an editor (at `line` when given) or reveals a folder in the Explorer. */
  private readonly openFile = Effect.fn("ChatView.openFile")(function* (
    this: ChatViewProvider,
    file: string,
    line: number | undefined,
  ) {
    const resolved = file.startsWith("~/") ? path.join(os.homedir(), file.slice(2)) : path.resolve(this.cwd(), file);
    const uri = vscode.Uri.file(resolved);
    const stat = yield* thenable(() => vscode.workspace.fs.stat(uri)).pipe(Effect.option);
    if (Option.isNone(stat)) {
      vscode.window.setStatusBarMessage(t("chat.fileNotFound", file), 4000);
      return;
    }
    if (stat.value.type & vscode.FileType.Directory) {
      yield* thenable(() => vscode.commands.executeCommand("revealInExplorer", uri));
      return;
    }
    const position = line ? new vscode.Position(line - 1, 0) : undefined;
    yield* thenable(() =>
      vscode.window.showTextDocument(uri, position ? { selection: new vscode.Range(position, position) } : {}),
    );
  });

  /** The process of the agent `tab` runs on, started on first use; the tab is set to that agent. */
  private readonly getAgent = Effect.fn("ChatView.getAgent")(function* (this: ChatViewProvider, tab: Tab) {
    const agentId = yield* this.agentIdOf(tab);
    if (!agentId) {
      return yield* new NoAgentError();
    }
    if (agentId !== CUSTOM_AGENT && tab.agentId !== agentId) {
      tab.agentId = agentId;
      this.postTabs();
    }
    return yield* Semaphore.withPermits(this.startLock, 1)(
      Effect.suspend(() => {
        const running = this.running.get(agentId);
        return running ? Effect.succeed(running) : this.startAgent(agentId, tab);
      }),
    );
  });

  private readonly startAgent = Effect.fn("ChatView.startAgent")(function* (
    this: ChatViewProvider,
    agentId: string,
    tab: Tab,
  ) {
    const command = yield* this.commandFor(agentId);
    if (!command) {
      return yield* new NoAgentError();
    }
    this.status(tab, "chat.starting");
    const scope = yield* Scope.make();
    // Set once spawned; the agent sends nothing before it answers `initialize`.
    let running: RunningAgent | undefined;
    const agent = yield* spawnAgent(command, {
      onUpdate: (n) => {
        const tab = running && this.tabForSession(running, n.sessionId);
        if (!tab) {
          return;
        }
        if (n.update.sessionUpdate === "session_info_update" && n.update.title !== undefined) {
          tab.title = n.update.title ?? undefined;
          this.postTabs();
        }
        this.postTab(tab, { type: "update", update: n.update });
        if (n.update.sessionUpdate === "usage_update") {
          const { used, size, cost } = n.update;
          const compactAt = tab.usageSessionId === n.sessionId ? tab.usage?.compactAt : undefined;
          tab.usage = { used, size, cost, compactAt };
          tab.usageSessionId = n.sessionId;
          this.saveTabs();
          this.postCompactWindow(tab, n.update);
        }
      },
      requestPermission: (req, signal) =>
        running ? this.requestPermission(running, req, signal) : Effect.succeed(CANCELLED),
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
    this.running.set(agentId, started);
    return started;
  });

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
        const window = yield* (yield* ClaudeSettings).autoCompactWindow(model, tab.cwd ?? this.cwd());
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
    if (this.running.get(running.agentId) !== running) {
      return;
    }
    this.running.delete(running.agentId);
    for (const tab of this.tabs) {
      if (tab.running !== running) {
        continue;
      }
      this.cancelPendingPermissions(tab);
      if (tab.sessionId && tab.used) {
        tab.reopen = { sessionId: tab.sessionId, cwd: tab.cwd ?? this.cwd(), agentId: running.agentId };
      }
      tab.sessionId = undefined;
      tab.running = undefined;
      tab.busy = false;
      this.status(tab, "chat.stopped", { stopped: true });
    }
    // A separate fiber: this one runs inside the scope being closed.
    this.runtime.runFork(Scope.close(running.scope, Exit.void));
  }

  private cwd(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
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
        const res = yield* running.agent.newSession(this.cwd());
        if (!this.tabs.includes(tab)) {
          // Closed while the session was starting.
          yield* this.closeSessionOnAgent(running, res.sessionId);
          return res.sessionId;
        }
        tab.sessionId = res.sessionId;
        tab.running = running;
        tab.cwd = undefined;
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
    const caps = running.agent.initializeResponse.agentCapabilities;
    const canOpen = !!caps?.loadSession || !!caps?.sessionCapabilities?.resume;
    if (canOpen && reopen.agentId === running.agentId) {
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
    tab.used = false;
    this.postTabs();
    return undefined;
  });

  /** Shows a past session in `tab`, replaying its history when the agent supports session/load. */
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
    // Set first: the replayed updates are only forwarded for a tab's session.
    tab.sessionId = sessionId;
    tab.running = running;
    tab.cwd = cwd;
    tab.used = true;
    tab.busy = true;
    this.status(tab, "chat.loadingSession");
    const res = yield* (
      caps?.loadSession
        ? agent.loadSession(sessionId, cwd)
        : agent.resumeSession(sessionId, cwd).pipe(
            Effect.tap(() => Effect.sync(() => this.postTab(tab, { type: "notice", key: "chat.resumedNoHistory" }))),
          )
    ).pipe(
      Effect.tapError(() =>
        Effect.sync(() => {
          tab.sessionId = undefined;
          tab.running = undefined;
          tab.cwd = undefined;
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
  });

  /** The tab's session, created when missing; undefined when the user has to act first. */
  private ensureSession(tab: Tab): Effect.Effect<string | undefined, AgentStartError | AgentRequestError, Output> {
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
  private readonly stopIdleAgents = Effect.fn("ChatView.stopIdleAgents")(function* (this: ChatViewProvider) {
    const custom = !!this.customCommand();
    const inUse = (running: RunningAgent) =>
      this.tabs.some(
        (tab) => tab.running === running || (!tab.running && (custom ? CUSTOM_AGENT : tab.agentId) === running.agentId),
      );
    for (const running of [...this.running.values()]) {
      if (!inUse(running)) {
        this.running.delete(running.agentId);
        yield* Scope.close(running.scope, Exit.void);
      }
    }
  });

  /** Switches `tab` to another agent, starting over in a fresh session; it also becomes the default for new tabs. */
  private readonly setTabAgent = Effect.fn("ChatView.setTabAgent")(function* (
    this: ChatViewProvider,
    tab: Tab,
    agentId: string,
  ) {
    yield* this.manager.setActive(agentId);
    if (tab.agentId === agentId) {
      return;
    }
    if (tab.busy) {
      yield* this.cancelTab(tab).pipe(Effect.ignore);
    }
    this.cancelPendingPermissions(tab);
    if (tab.sessionId) {
      yield* this.closeSessionOnAgent(tab.running, tab.sessionId);
    }
    tab.agentId = agentId;
    tab.sessionId = undefined;
    tab.running = undefined;
    tab.busy = false;
    tab.used = false;
    tab.title = undefined;
    tab.reopen = undefined;
    tab.usage = undefined;
    tab.usageSessionId = undefined;
    this.postTab(tab, { type: "reset" });
    this.postTabs();
    yield* this.stopIdleAgents();
    yield* this.ensureSession(tab);
  });

  /** The agent the active tab runs on. */
  get activeAgentId(): Effect.Effect<string | undefined> {
    return this.agentIdOf(this.active);
  }

  /** Switches the active tab to another agent (command palette). */
  readonly setAgent = Effect.fn("ChatView.setAgent")(function* (this: ChatViewProvider, agentId: string) {
    yield* this.setTabAgent(this.active, agentId);
  });

  /** Opens a new tab with a fresh session. */
  readonly newSession = Effect.fn("ChatView.newSession")(function* (this: ChatViewProvider) {
    const tab = this.addTab();
    tab.agentId = yield* this.manager.activeId;
    this.active = tab;
    this.postTabs();
    yield* thenable(() => vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`));
    yield* this.ensureSession(tab);
  });

  private readonly selectTab = Effect.fn("ChatView.selectTab")(function* (this: ChatViewProvider, tab: Tab) {
    this.active = tab;
    this.postTabs();
    if (!tab.busy) {
      yield* this.ensureSession(tab);
    }
  });

  private readonly closeTab = Effect.fn("ChatView.closeTab")(function* (this: ChatViewProvider, tab: Tab) {
    const index = this.tabs.indexOf(tab);
    if (index < 0) {
      return;
    }
    if (tab.busy) {
      yield* this.cancelTab(tab).pipe(Effect.ignore);
    }
    this.cancelPendingPermissions(tab);
    this.tabs.splice(index, 1);
    if (tab.sessionId) {
      yield* this.closeSessionOnAgent(tab.running, tab.sessionId);
    }
    yield* this.stopIdleAgents();
    if (this.tabs.length === 0) {
      yield* this.newSession();
      return;
    }
    if (this.active === tab) {
      this.active = this.tabs[Math.min(index, this.tabs.length - 1)]!;
    }
    this.postTabs();
    yield* this.ensureSession(this.active);
  });

  /** Shows the agent's past sessions for this workspace in the chat view. */
  readonly showHistory = Effect.fn("ChatView.showHistory")(function* (this: ChatViewProvider) {
    yield* thenable(() => vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`));
    this.post({ type: "history", loading: true, sessions: [] });
    const running = yield* this.getAgent(this.active).pipe(Effect.catchTag("NoAgentError", () => Effect.undefined));
    const agent = running?.agent;
    const caps = agent?.initializeResponse.agentCapabilities;
    if (!agent || !caps?.sessionCapabilities?.list) {
      this.post({ type: "history", unsupported: true, sessions: [] });
      return;
    }
    const sessions: Array<acp.SessionInfo> = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
      const res = yield* agent.listSessions(this.cwd(), cursor);
      sessions.push(...res.sessions);
      cursor = res.nextCursor ?? undefined;
      if (!cursor) {
        break;
      }
    }
    this.post({
      type: "history",
      sessions,
      currentId: this.active.sessionId,
      openIds: this.tabs.flatMap((tab) => {
        const id = tab.sessionId ?? tab.reopen?.sessionId;
        return id ? [id] : [];
      }),
      // Without load or resume the list can only be looked at.
      canOpen: !!caps.loadSession || !!caps.sessionCapabilities.resume,
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
    const open = this.tabs.find((tab) => tab.sessionId === sessionId || tab.reopen?.sessionId === sessionId);
    if (open) {
      yield* this.selectTab(open);
      return;
    }
    // The history lists the active tab's agent's sessions.
    const from = this.active;
    const running = yield* this.getAgent(from);
    const reuse = !from.used && !from.busy;
    const tab = reuse ? from : this.addTab();
    const replaced = tab.sessionId;
    const replacedOn = tab.running;
    this.active = tab;
    tab.agentId = from.agentId;
    tab.title = title?.trim() || undefined;
    tab.reopen = undefined;
    this.postTabs();
    if (replaced) {
      yield* this.closeSessionOnAgent(replacedOn, replaced);
    }
    yield* this.loadInto(tab, running, sessionId, cwd).pipe(
      // Fall back to a fresh session so the tab stays usable.
      Effect.tapError(() => this.ensureSession(tab)),
    );
    this.saveTabs();
  });

  private readonly send = Effect.fn("ChatView.send")(function* (
    this: ChatViewProvider,
    tab: Tab,
    parts: ReadonlyArray<PromptPart>,
    includeActiveFile: boolean,
  ) {
    const text = parts.map((part) => (typeof part === "string" ? part : (part.token ?? ""))).join("");
    if (tab.busy || parts.every((part) => typeof part === "string" && !part.trim())) {
      return;
    }
    const sessionId = yield* this.ensureSession(tab);
    const agent = tab.running?.agent;
    if (!sessionId || !agent) {
      return;
    }
    const prompt: Array<acp.ContentBlock> = [];
    const sent: Array<SentAttachment> = [];
    for (const attachment of parts) {
      if (typeof attachment === "string") {
        if (attachment.trim()) {
          prompt.push({ type: "text", text: attachment });
        }
        continue;
      }
      const block = yield* this.attachmentBlock(agent, attachment).pipe(
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
    const editor = vscode.window.activeTextEditor;
    if (includeActiveFile && editor && editor.document.uri.scheme === "file") {
      const uri = editor.document.uri;
      prompt.push({
        type: "resource_link",
        uri: uri.toString(),
        name: vscode.workspace.asRelativePath(uri),
      });
      if (!editor.selection.isEmpty) {
        const sel = editor.selection;
        prompt.push({
          type: "text",
          text: `Selection (${vscode.workspace.asRelativePath(uri)}:${sel.start.line + 1}-${sel.end.line + 1}):\n${editor.document.getText(sel)}`,
        });
      }
    }

    tab.used = true;
    if (!tab.title) {
      const firstLine = text.trim().split("\n")[0] || sent[0]?.name || "";
      tab.title = firstLine.length > MAX_TITLE_LENGTH ? `${firstLine.slice(0, MAX_TITLE_LENGTH - 1)}…` : firstLine;
    }
    this.postTabs();
    this.postTab(tab, { type: "userMessage", text, attachments: sent });
    tab.busy = true;
    this.status(tab, "chat.working");
    yield* agent.prompt(sessionId, prompt).pipe(
      Effect.tap((res) => Effect.sync(() => this.postTab(tab, { type: "turnEnd", stopReason: res.stopReason }))),
      Effect.catchTag("AuthRequiredError", () =>
        Effect.sync(() => {
          tab.sessionId = undefined;
          this.status(tab, "chat.needsLogin", { needsLogin: true });
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          tab.busy = false;
          if (tab.sessionId) {
            this.status(tab, "chat.ready");
          } else {
            this.refreshStatus(tab);
          }
        }),
      ),
    );
  });

  /** Adds files/folders to the composer (Explorer / editor tab context menu). */
  readonly attach = Effect.fn("ChatView.attach")(function* (this: ChatViewProvider, uris: ReadonlyArray<vscode.Uri>) {
    this.queuedAttachments.push(
      ...uris.map((uri): Attachment => ({ kind: "uri", uri: uri.toString(), name: path.basename(uri.path) })),
    );
    yield* thenable(() => vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`));
    this.flushAttachments();
  });

  /** Adds the editor's non-empty selections to the composer as snippets (editor context menu). */
  readonly attachSelection = Effect.fn("ChatView.attachSelection")(function* (
    this: ChatViewProvider,
    editor: vscode.TextEditor,
  ) {
    const doc = editor.document;
    for (const sel of editor.selections) {
      if (sel.isEmpty) {
        continue;
      }
      // A selection ending at column 0 doesn't really include that line.
      const end = sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line - 1 : sel.end.line;
      const startLine = sel.start.line + 1;
      const endLine = end + 1;
      const range = startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`;
      this.queuedAttachments.push({
        kind: "snippet",
        uri: doc.uri.toString(),
        name: `${path.basename(doc.uri.path)}:${range}`,
        languageId: doc.languageId,
        startLine,
        endLine,
        text: doc.getText(sel),
      });
    }
    yield* thenable(() => vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`));
    this.flushAttachments();
  });

  /** Quotes text selected in the transcript into the composer (webview context menu). */
  quote(text: string): void {
    if (text.trim()) {
      this.post({ type: "quote", text });
    }
  }

  private flushAttachments(): void {
    if (this.view && this.queuedAttachments.length) {
      this.post({ type: "addAttachments", attachments: this.queuedAttachments });
      this.queuedAttachments = [];
    }
  }

  private readonly attachmentBlock = Effect.fn("ChatView.attachmentBlock")(function* (
    this: ChatViewProvider,
    agent: AcpAgent,
    attachment: Attachment,
  ): Effect.fn.Return<acp.ContentBlock, VscodeError | PlatformError.PlatformError, FileSystem.FileSystem> {
    const caps = agent.initializeResponse.agentCapabilities?.promptCapabilities ?? {};
    if (attachment.kind === "data") {
      if (attachment.mimeType.startsWith("image/") && caps.image) {
        return { type: "image", mimeType: attachment.mimeType, data: attachment.data };
      }
      // No path to point at: save to a temp file so any agent can read it via resource_link.
      const fs = yield* FileSystem.FileSystem;
      const dir = path.join(os.tmpdir(), "code-acp");
      yield* fs.makeDirectory(dir, { recursive: true });
      const file = path.join(dir, `${yield* Clock.currentTimeMillis}-${path.basename(attachment.name) || "attachment"}`);
      yield* fs.writeFile(file, Buffer.from(attachment.data, "base64"));
      return {
        type: "resource_link",
        uri: vscode.Uri.file(file).toString(),
        name: attachment.name,
        mimeType: attachment.mimeType || undefined,
      };
    }

    const uri = vscode.Uri.parse(attachment.uri);
    const name = uri.scheme === "file" ? vscode.workspace.asRelativePath(uri) : attachment.name;
    if (attachment.kind === "snippet") {
      const { startLine, endLine, text } = attachment;
      const lines = startLine === endLine ? `L${startLine}` : `L${startLine}-${endLine}`;
      if (caps.embeddedContext) {
        return { type: "resource", resource: { uri: uri.with({ fragment: lines }).toString(), text } };
      }
      // Fence longer than any backtick run in the snippet.
      const fence = "`".repeat(Math.max(3, ...Array.from(text.matchAll(/`+/g), (m) => m[0].length + 1)));
      return { type: "text", text: `${name}#${lines}\n${fence}${attachment.languageId}\n${text}\n${fence}` };
    }
    const stat = yield* thenable(() => vscode.workspace.fs.stat(uri));
    if (stat.type & vscode.FileType.Directory) {
      return { type: "resource_link", uri: uri.toString(), name: `${name}/`, description: t("chat.folder") };
    }
    const imageMime = IMAGE_MIME[path.extname(uri.path).toLowerCase()];
    if (imageMime && caps.image) {
      const bytes = yield* thenable(() => vscode.workspace.fs.readFile(uri));
      return { type: "image", mimeType: imageMime, data: Buffer.from(bytes).toString("base64"), uri: uri.toString() };
    }
    if (!imageMime && caps.embeddedContext && stat.size <= MAX_EMBED_BYTES) {
      const bytes = yield* thenable(() => vscode.workspace.fs.readFile(uri));
      if (!bytes.includes(0)) {
        return { type: "resource", resource: { uri: uri.toString(), text: new TextDecoder().decode(bytes) } };
      }
    }
    return { type: "resource_link", uri: uri.toString(), name, size: stat.size, mimeType: imageMime };
  });

  /** Stops the active tab's turn. */
  readonly cancel = Effect.fn("ChatView.cancel")(function* (this: ChatViewProvider) {
    yield* this.cancelTab(this.active);
  });

  private readonly cancelTab = Effect.fn("ChatView.cancelTab")(function* (this: ChatViewProvider, tab: Tab) {
    // ACP: the client must answer pending permission requests with "cancelled" on cancel.
    this.cancelPendingPermissions(tab);
    if (tab.running && tab.sessionId) {
      yield* tab.running.agent.cancel(tab.sessionId);
    }
  });

  private readonly requestPermission = Effect.fn("ChatView.requestPermission")(function* (
    this: ChatViewProvider,
    running: RunningAgent,
    req: acp.RequestPermissionRequest,
    signal: AbortSignal,
  ) {
    const tab = this.tabForSession(running, req.sessionId);
    if (!tab) {
      // Its tab was closed.
      return CANCELLED;
    }
    const id = this.nextPermissionId++;
    const answer = yield* Deferred.make<acp.RequestPermissionResponse>();
    this.pendingPermissions.set(id, { tab, answer });
    this.view?.show(true);
    this.postTab(tab, { type: "permissionRequest", id, toolCall: req.toolCall, options: req.options });
    const onAbort = () => this.resolvePermission(id, CANCELLED);
    signal.addEventListener("abort", onAbort, { once: true });
    return yield* Deferred.await(answer).pipe(
      Effect.ensuring(Effect.sync(() => signal.removeEventListener("abort", onAbort))),
    );
  });

  private resolvePermission(id: number, response: acp.RequestPermissionResponse): void {
    const pending = this.pendingPermissions.get(id);
    if (pending) {
      this.pendingPermissions.delete(id);
      Deferred.doneUnsafe(pending.answer, Effect.succeed(response));
      this.postTab(pending.tab, { type: "permissionDone", id });
    }
  }

  /** Answers "cancelled" to the pending permission requests of `tab`, or of every tab. */
  private cancelPendingPermissions(tab?: Tab): void {
    for (const [id, pending] of [...this.pendingPermissions]) {
      if (!tab || pending.tab === tab) {
        this.resolvePermission(id, CANCELLED);
      }
    }
  }

  readonly login = Effect.fn("ChatView.login")(function* (this: ChatViewProvider) {
    const running = yield* this.getAgent(this.active);
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
      const cmd = yield* this.commandFor(running.agentId);
      if (!cmd) {
        return;
      }
      const terminal = vscode.window.createTerminal({
        name: "ACP Login",
        shellPath: cmd.command,
        shellArgs: [...cmd.args, ...(picked.args ?? [])],
        env: { ...cmd.env, ...(picked.env ?? {}) },
        cwd: this.cwd(),
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
      yield* this.ensureSession(this.active);
    }
  });

  /**
   * Restarts the agent `agentId`, or every agent; their tabs start over, the active one right away and the others
   * when selected.
   */
  readonly restart = Effect.fn("ChatView.restart")(function* (this: ChatViewProvider, agentId?: string) {
    const stopped = [...this.running.values()].filter((running) => agentId === undefined || running.agentId === agentId);
    for (const running of stopped) {
      this.running.delete(running.agentId);
    }
    for (const tab of this.tabs) {
      const affected = tab.running
        ? stopped.includes(tab.running)
        : agentId === undefined || (tab.reopen?.agentId ?? tab.agentId) === agentId;
      if (!affected) {
        continue;
      }
      this.cancelPendingPermissions(tab);
      tab.sessionId = undefined;
      tab.running = undefined;
      tab.busy = false;
      tab.used = false;
      tab.title = undefined;
      tab.reopen = undefined;
      this.postTab(tab, { type: "reset" });
    }
    this.postTabs();
    for (const running of stopped) {
      yield* Scope.close(running.scope, Exit.void);
    }
    yield* this.ensureSession(this.active);
  });

  dispose(): void {
    this.cancelPendingPermissions();
    const running = [...this.running.values()];
    this.running.clear();
    for (const each of running) {
      // Finalizers are synchronous, so the process is killed before this returns.
      this.runtime.runFork(Scope.close(each.scope, Exit.void));
    }
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
