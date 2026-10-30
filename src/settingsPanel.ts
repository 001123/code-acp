import { Effect, Predicate } from "effect";
import * as path from "node:path";
import * as vscode from "vscode";
import type { AgentManager } from "./agentManager";
import { CommitMessage } from "./commitMessage";
import { onDidChangeLocale, t, webviewL10n } from "./i18n";
import { ManagerPanel } from "./managerPanel";
import { runIn, thenable, type AppRuntime, type AppServices } from "./runtime";
import { LOWEST_EFFORT } from "./sessionOptions";
import { DEFAULT_COMMIT_INSTRUCTIONS, isValidSetting, SETTING_KEYS, type SettingKey } from "./settings";
import { UsageLedger, type SessionQuery, type UsageSummary } from "./usageLedger";
import { webviewHtml, webviewRoots } from "./webview";

export type FromWebview =
  | { type: "ready" }
  | { type: "set"; key: SettingKey; value: unknown }
  | { type: "use"; id: string }
  | { type: "manageAgents" }
  | { type: "openNative" }
  | { type: "clearUsage" }
  /** The sessions the Usage tab lists: those matching `text`, the `limit` most recent. */
  | { type: "usageQuery"; text: string; limit: number }
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
  if (key === "notifications") return value === true;
  if (key === "commitMessage.effort") return value === LOWEST_EFFORT;
  if (key === "commitMessage.fastMode") return value === "default";
  // Empty is a real choice here: no extra instructions.
  if (key === "commitMessage.instructions") return value === DEFAULT_COMMIT_INSTRUCTIONS;
  if (Array.isArray(value)) return value.length === 0;
  if (Predicate.isObject(value)) return Object.keys(value).length === 0;
  return value === "";
}

/** Webview page for the extension's settings (user scope), with a link to the native Settings UI. */
export class SettingsPanel {
  private static current?: SettingsPanel;

  private readonly disposables: vscode.Disposable[] = [];
  /** The tab to show once the page is ready. */
  private pendingTab?: string;
  private usageQuery: SessionQuery = { text: "", limit: USAGE_PAGE };

  /** Opens the page, on `tab` when given (e.g. "usage"). */
  static show(context: vscode.ExtensionContext, runtime: AppRuntime, manager: AgentManager["Service"], tab?: string): void {
    if (SettingsPanel.current) {
      SettingsPanel.current.panel.reveal();
      if (tab) {
        void SettingsPanel.current.panel.webview.postMessage({ type: "selectTab", tab });
      }
      return;
    }
    const panel = vscode.window.createWebviewPanel("codeAcp.settings", t("settings.title"), vscode.ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: webviewRoots(context.extensionUri),
    });
    SettingsPanel.current = new SettingsPanel(panel, context, runtime, manager);
    SettingsPanel.current.pendingTab = tab;
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly runtime: AppRuntime,
    private readonly manager: AgentManager["Service"],
  ) {
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "icon.svg");
    panel.webview.html = webviewHtml(panel.webview, context.extensionUri, "settings");
    this.disposables.push(
      panel.webview.onDidReceiveMessage((msg: FromWebview) => this.run(this.onMessage(msg))),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("codeAcp")) this.run(this.render);
      }),
      onDidChangeLocale(() => {
        panel.title = t("settings.title");
        void panel.webview.postMessage(webviewL10n());
      }),
      manager.onDidChange(() => this.run(Effect.andThen(this.render, this.renderUsage))),
      panel.onDidDispose(() => this.dispose()),
    );
    this.run(
      UsageLedger.use((ledger) =>
        Effect.sync(() => this.disposables.push(ledger.onDidChange(() => this.run(this.renderUsage)))),
      ),
    );
  }

  private run<E>(effect: Effect.Effect<void, E, AppServices>): void {
    void runIn(this.runtime, effect, (message) => void vscode.window.showErrorMessage(`Code ACP: ${message}`));
  }

  private readonly onMessage = Effect.fn("SettingsPanel.onMessage")(function* (this: SettingsPanel, msg: FromWebview) {
    switch (msg.type) {
      case "ready":
        if (this.pendingTab) {
          void this.panel.webview.postMessage({ type: "selectTab", tab: this.pendingTab });
          this.pendingTab = undefined;
        }
        yield* this.render;
        yield* this.renderUsage;
        break;
      case "usageQuery":
        this.usageQuery = { text: msg.text, limit: Math.max(USAGE_PAGE, msg.limit) };
        yield* this.renderUsage;
        break;
      case "clearUsage": {
        const ok = yield* thenable(() =>
          vscode.window.showWarningMessage(t("usage.clearConfirm"), { modal: true }, t("usage.clear")),
        );
        if (ok) {
          yield* UsageLedger.use((ledger) => ledger.clear);
        }
        break;
      }
      case "set":
        if (SETTING_KEYS.includes(msg.key) && isValidSetting(msg.key, msg.value)) {
          const value = isDefault(msg.key, msg.value) ? undefined : msg.value;
          yield* thenable(() =>
            vscode.workspace.getConfiguration("codeAcp").update(msg.key, value, vscode.ConfigurationTarget.Global),
          );
        }
        break;
      case "use":
        if (yield* this.manager.has(msg.id)) {
          yield* this.manager.setActive(msg.id);
        }
        break;
      case "manageAgents":
        ManagerPanel.show(this.context, this.runtime, this.manager);
        break;
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

  private get render(): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const config = vscode.workspace.getConfiguration("codeAcp");
      const values: Record<string, unknown> = {};
      const overridden: SettingKey[] = [];
      for (const key of SETTING_KEYS) {
        const info = config.inspect(key);
        values[key] = info?.globalValue ?? info?.defaultValue;
        if (info?.workspaceValue !== undefined || info?.workspaceFolderValue !== undefined) {
          overridden.push(key);
        }
      }
      void this.panel.webview.postMessage({
        type: "state",
        values,
        overridden,
        agents: yield* this.manager.agents,
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
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
