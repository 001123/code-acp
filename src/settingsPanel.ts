import { Effect, Option, Predicate, Schema } from "effect";
import * as path from "node:path";
import * as vscode from "vscode";
import { AgentCatalog, CATALOG_IMG_SRC, type CatalogMessage, type CatalogState } from "./agentCatalog";
import type { AgentManager } from "./agentManager";
import { Ccusage, isCcusageSource } from "./ccusage";
import { AutoApprove } from "./chat/autoApprove";
import { CommitMessage } from "./commitMessage";
import { DoctorPage, LOGIN_AGENT_COMMAND, type DoctorMessage, type DoctorState } from "./doctor";
import { onDidChangeLocale, t, webviewL10n } from "./i18n";
import { runIn, thenable, type AppRuntime, type AppServices } from "./runtime";
import { LOWEST_EFFORT } from "./sessionOptions";
import {
  ApprovalRules,
  DEFAULT_COMMIT_INSTRUCTIONS,
  isValidSetting,
  lockedSettings,
  SETTING_KEYS,
  WORKSPACE_ONLY_SETTINGS,
  type SettingKey,
  type SettingsScope,
} from "./settings";
import { UsageLedger, type SessionQuery, type UsageSummary } from "./usageLedger";
import { webviewHtml, webviewRoots } from "./webview";

export type FromWebview =
  | CatalogMessage
  | DoctorMessage
  | { type: "ready" }
  | { type: "set"; key: SettingKey; value: unknown }
  /** The rules of this workspace for answering permission requests, which are no setting. */
  | { type: "workspaceAutoApprove"; rules: unknown }
  /** Which settings the page reads and writes from now on. */
  | { type: "scope"; scope: SettingsScope }
  | { type: "use"; id: string }
  | { type: "openNative" }
  | { type: "clearUsage" }
  /** The sessions the Usage tab lists: those matching `text`, the `limit` most recent. */
  | { type: "usageQuery"; text: string; limit: number }
  /** The ccusage report of a source, run again when `refresh`; answered with a "ccusage" message. */
  | { type: "ccusage"; source: string; refresh: boolean }
  /** Asks an agent (empty: the default one) for its models, and the efforts of `model` (empty: its default one). */
  | { type: "loadModels"; agentId: string; model: string };

/** A session row of the Usage tab: its agent by name and its folder by base name. */
export type UsageSessionRow = UsageSummary["sessions"][number] & { agentName: string; folder: string };

/** What the Usage tab shows ("usage" message), with agents by name. */
export type UsageView = Omit<UsageSummary, "sessions" | "agents"> & {
  sessions: UsageSessionRow[];
  agents: Array<UsageSummary["agents"][number] & { agentName: string }>;
  /** The query the sessions answer, and how many more "show more" adds. */
  query: SessionQuery;
  pageSize: number;
};

/** Sessions the Usage tab lists at first, and adds with each "show more". */
export const USAGE_PAGE = 50;

/** Values equal to the default are removed from settings.json instead of written. */
function isDefault(key: SettingKey, value: unknown): boolean {
  if (key === "language") return value === "auto";
  if (key === "nodePath") return value === "" || value === "node";
  if (key === "checkAgentUpdates") return value === true;
  if (key === "followAgent") return value === false;
  if (key === "autoScroll") return value === true;
  if (key === "showChanges") return value === true;
  if (key === "showRestore") return value === false;
  if (key === "fontSize" || key === "codeFontSize") return value === 0;
  if (key === "tracing") return value === false;
  if (key === "notifications") return value === true;
  if (key === "notifyFinished") return value === true;
  if (key === "worktreeForNewTabs") return value === false;
  if (key === "commitMessage.effort") return value === LOWEST_EFFORT;
  if (key === "commitMessage.fastMode") return value === "default";
  // Empty is a real choice here: no extra instructions.
  if (key === "commitMessage.instructions") return value === DEFAULT_COMMIT_INSTRUCTIONS;
  if (Array.isArray(value)) return value.length === 0;
  if (Predicate.isObject(value)) return Object.keys(value).length === 0;
  return value === "";
}

/** What a setting is worth in a workspace that doesn't set it. */
function inherited(key: SettingKey, info: SettingInspection | undefined): unknown {
  return WORKSPACE_ONLY_SETTINGS.includes(key) ? info?.defaultValue : (info?.globalValue ?? info?.defaultValue);
}

/** The levels of a setting, as `inspect` reports them. */
export interface SettingInspection {
  readonly defaultValue?: unknown;
  readonly globalValue?: unknown;
  readonly workspaceValue?: unknown;
  readonly workspaceFolderValue?: unknown;
}

/** The value to store for `key` in `scope`; undefined removes it. */
export function valueToStore(
  scope: SettingsScope,
  key: SettingKey,
  value: unknown,
  info: SettingInspection | undefined,
): unknown {
  if (scope === "user") {
    return isDefault(key, value) ? undefined : value;
  }
  // Removed rather than stored, so that the workspace keeps following the user's later changes.
  return JSON.stringify(value) === JSON.stringify(inherited(key, info)) ? undefined : value;
}

/** What the page shows for `key` in `scope`, and whether a workspace value is worth pointing out. */
export function scopedSetting(
  scope: SettingsScope,
  key: SettingKey,
  info: SettingInspection | undefined,
): { value: unknown; overridden: boolean } {
  const locked = lockedSettings(scope).includes(key);
  if (scope === "workspace") {
    const set = !locked && info?.workspaceValue !== undefined;
    return { value: set ? info?.workspaceValue : inherited(key, info), overridden: set };
  }
  return {
    value: info?.globalValue ?? info?.defaultValue,
    overridden: !locked && (info?.workspaceValue !== undefined || info?.workspaceFolderValue !== undefined),
  };
}

/** Webview page for the extension's settings, of the user or the open workspace, with a link to the native Settings UI. */
export class SettingsPanel {
  private static current?: SettingsPanel;
  private static readonly viewType = "kdCode.settings";

  private readonly disposables: vscode.Disposable[] = [];
  private readonly catalog: AgentCatalog;
  private readonly doctor: DoctorPage;
  /** The tab to show once the page is ready. */
  private pendingSelect?: { type: "selectTab"; tab: string; section?: string };
  private usageQuery: SessionQuery = { text: "", limit: USAGE_PAGE };
  private pickedScope: SettingsScope = "user";

  /** Opens the page, on `tab` (e.g. "usage") and its `section` when given. */
  static show(
    context: vscode.ExtensionContext,
    runtime: AppRuntime,
    manager: AgentManager["Service"],
    tab?: string,
    section?: string,
  ): void {
    const select = tab ? ({ type: "selectTab", tab, section } as const) : undefined;
    const current = SettingsPanel.current;
    if (current) {
      // A hidden page reloads when revealed, so it can only be told once it is ready again.
      const visible = current.panel.visible;
      current.panel.reveal();
      if (!visible) {
        current.pendingSelect = select;
      } else if (select) {
        void current.panel.webview.postMessage(select);
      }
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      SettingsPanel.viewType,
      t("settings.title"),
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        localResourceRoots: webviewRoots(context.extensionUri),
      },
    );
    SettingsPanel.current = new SettingsPanel(panel, context, runtime, manager);
    SettingsPanel.current.pendingSelect = select;
  }

  /** Brings the page back after a window reload; the page restores its own tab from its saved state. */
  static registerSerializer(
    context: vscode.ExtensionContext,
    runtime: AppRuntime,
    manager: AgentManager["Service"],
  ): vscode.Disposable {
    return vscode.window.registerWebviewPanelSerializer(SettingsPanel.viewType, {
      deserializeWebviewPanel: async (panel) => {
        if (SettingsPanel.current) {
          panel.dispose();
          return;
        }
        panel.webview.options = { enableScripts: true, localResourceRoots: webviewRoots(context.extensionUri) };
        SettingsPanel.current = new SettingsPanel(panel, context, runtime, manager);
      },
    });
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly runtime: AppRuntime,
    private readonly manager: AgentManager["Service"],
  ) {
    panel.title = t("settings.title");
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "icon.svg");
    panel.webview.html = webviewHtml(panel.webview, context.extensionUri, "settings", CATALOG_IMG_SRC);
    // An install can outlast the page.
    this.catalog = new AgentCatalog(manager, (catalog: CatalogState) => {
      if (SettingsPanel.current === this) {
        void panel.webview.postMessage({ type: "catalog", catalog });
      }
    });
    // Stopped when the page closes; meanwhile hiding the page leaves it running.
    this.doctor = new DoctorPage((doctor: DoctorState) => {
      if (SettingsPanel.current === this) {
        void panel.webview.postMessage({ type: "doctor", doctor });
      }
    });
    this.disposables.push(
      panel.webview.onDidReceiveMessage((msg: FromWebview) => this.run(this.onMessage(msg))),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("kdCode")) this.run(this.render);
      }),
      onDidChangeLocale(() => {
        panel.title = t("settings.title");
        void panel.webview.postMessage(webviewL10n());
      }),
      manager.onDidChange(() =>
        this.run(Effect.all([this.render, this.renderUsage, this.catalog.render], { discard: true })),
      ),
      panel.onDidDispose(() => this.dispose()),
    );
    this.run(
      UsageLedger.use((ledger) =>
        Effect.sync(() => this.disposables.push(ledger.onDidChange(() => this.run(this.renderUsage)))),
      ),
    );
  }

  private get hasWorkspace(): boolean {
    return (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
  }

  private get scope(): SettingsScope {
    return this.hasWorkspace ? this.pickedScope : "user";
  }

  private run<E>(effect: Effect.Effect<void, E, AppServices>): void {
    void runIn(this.runtime, effect, (message) => void vscode.window.showErrorMessage(`KD Code: ${message}`));
  }

  private readonly onMessage = Effect.fn("SettingsPanel.onMessage")(function* (this: SettingsPanel, msg: FromWebview) {
    switch (msg.type) {
      case "ready":
        if (this.pendingSelect) {
          void this.panel.webview.postMessage(this.pendingSelect);
          this.pendingSelect = undefined;
        }
        yield* this.render;
        yield* this.renderUsage;
        yield* this.doctor.render;
        break;
      case "usageQuery":
        this.usageQuery = { text: msg.text, limit: Math.max(USAGE_PAGE, msg.limit) };
        yield* this.renderUsage;
        break;
      case "ccusage": {
        const source = msg.source;
        if (!isCcusageSource(source)) break;
        const result = yield* Ccusage.use((ccusage) => ccusage.report(source, msg.refresh)).pipe(
          Effect.map((view) => ({ view })),
          Effect.catchTag("CcusageError", (err) =>
            Effect.logError(err.message).pipe(Effect.as({ error: err.message })),
          ),
        );
        void this.panel.webview.postMessage({ type: "ccusage", source: msg.source, ...result });
        break;
      }
      case "clearUsage": {
        const ok = yield* thenable(() =>
          vscode.window.showWarningMessage(t("usage.clearConfirm"), { modal: true }, t("usage.clear")),
        );
        if (ok) {
          yield* UsageLedger.use((ledger) => ledger.clear);
        }
        break;
      }
      case "scope":
        this.pickedScope = msg.scope === "workspace" ? "workspace" : "user";
        yield* this.render;
        break;
      case "set": {
        const scope = this.scope;
        if (
          SETTING_KEYS.includes(msg.key) &&
          !lockedSettings(scope).includes(msg.key) &&
          isValidSetting(msg.key, msg.value)
        ) {
          const config = vscode.workspace.getConfiguration("kdCode");
          const value = valueToStore(scope, msg.key, msg.value, config.inspect(msg.key));
          const target =
            scope === "workspace" ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
          yield* thenable(() => config.update(msg.key, value, target));
        }
        break;
      }
      case "workspaceAutoApprove": {
        const rules = Schema.decodeUnknownOption(ApprovalRules)(msg.rules);
        if (Option.isSome(rules) && this.scope === "workspace") {
          yield* AutoApprove.use((autoApprove) => autoApprove.setWorkspaceRules(rules.value));
          yield* this.render;
        }
        break;
      }
      case "use":
        if ((yield* this.manager.agents).some((agent) => agent.id === msg.id)) {
          yield* this.manager.setActive(msg.id);
        }
        break;
      case "catalogLoad":
      case "catalogRefresh":
      case "catalogInstall":
      case "catalogUninstall":
      case "catalogOpen":
        yield* this.catalog.onMessage(msg);
        break;
      case "doctorRun":
        yield* this.doctor.run();
        break;
      case "doctorStop":
        yield* this.doctor.stop;
        break;
      case "doctorFix": {
        const fix = this.doctor.fixOf(msg.id);
        switch (fix?.type) {
          case "open":
            yield* thenable(() => vscode.env.openExternal(vscode.Uri.parse(fix.url)));
            break;
          case "manageAgents":
            void this.panel.webview.postMessage({ type: "selectTab", tab: "providers", section: "add" });
            break;
          case "login":
            yield* thenable(() => vscode.commands.executeCommand(LOGIN_AGENT_COMMAND, fix.agentId));
            break;
          case "showLog":
            yield* thenable(() => vscode.commands.executeCommand("kdCode.showLog"));
            break;
        }
        break;
      }
      case "loadModels": {
        const result = yield* CommitMessage.use((commit) => commit.options(msg.agentId, msg.model)).pipe(
          Effect.map((options) => ({ options })),
          Effect.catchTag("CommitMessageError", (err) => Effect.succeed({ error: err.message })),
        );
        void this.panel.webview.postMessage({ type: "models", agentId: msg.agentId, model: msg.model, ...result });
        break;
      }
      case "openNative":
        yield* thenable(() =>
          vscode.commands.executeCommand("workbench.action.openSettings", `@ext:${this.context.extension.id}`),
        );
        break;
    }
  });

  private get render(): Effect.Effect<void, never, AutoApprove> {
    return Effect.gen({ self: this }, function* () {
      const config = vscode.workspace.getConfiguration("kdCode");
      const values: Record<string, unknown> = {};
      const overridden: SettingKey[] = [];
      const scope = this.scope;
      for (const key of SETTING_KEYS) {
        const setting = scopedSetting(scope, key, config.inspect(key));
        values[key] = setting.value;
        if (setting.overridden) {
          overridden.push(key);
        }
      }
      const workspaceAutoApprove = yield* AutoApprove.use((autoApprove) => autoApprove.workspaceRules);
      if (Object.keys(workspaceAutoApprove).length > 0) {
        overridden.push("autoApprove");
      }
      void this.panel.webview.postMessage({
        type: "state",
        values,
        overridden,
        workspaceAutoApprove,
        scope,
        hasWorkspace: this.hasWorkspace,
        workspaceName: vscode.workspace.name,
        locked: lockedSettings(scope),
        agents: yield* this.manager.agents,
        providers: yield* this.manager.providers,
        activeId: yield* this.manager.activeId,
      });
    });
  }

  /** The Usage tab, with agents by name. */
  private get renderUsage(): Effect.Effect<void, never, UsageLedger> {
    return Effect.gen({ self: this }, function* () {
      const names = new Map((yield* this.manager.agents).map((a) => [a.id, a.name]));
      const nameOf = (id: string) => names.get(id) ?? id;
      const summary = yield* (yield* UsageLedger).summary(this.usageQuery, (s) => nameOf(s.agentId));
      const usage: UsageView = {
        ...summary,
        sessions: summary.sessions.map((s) => ({ ...s, agentName: nameOf(s.agentId), folder: path.basename(s.cwd) })),
        agents: summary.agents.map((a) => ({ ...a, agentName: nameOf(a.agentId) })),
        query: this.usageQuery,
        pageSize: USAGE_PAGE,
      };
      void this.panel.webview.postMessage({ type: "usage", usage });
    });
  }

  private dispose(): void {
    SettingsPanel.current = undefined;
    this.run(this.doctor.stop);
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
