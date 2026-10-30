import { Effect, Predicate } from "effect";
import * as vscode from "vscode";
import type { AgentManager } from "./agentManager";
import { CommitMessage } from "./commitMessage";
import { onDidChangeLocale, t, webviewL10n } from "./i18n";
import { ManagerPanel } from "./managerPanel";
import { runIn, thenable, type AppRuntime, type AppServices } from "./runtime";
import { LOWEST_EFFORT } from "./sessionOptions";
import { DEFAULT_COMMIT_INSTRUCTIONS, isValidSetting, SETTING_KEYS, type SettingKey } from "./settings";
import { webviewHtml, webviewRoots } from "./webview";

export type FromWebview =
  | { type: "ready" }
  | { type: "set"; key: SettingKey; value: unknown }
  | { type: "use"; id: string }
  | { type: "manageAgents" }
  | { type: "openNative" }
  /** Asks an agent (empty: the default one) for its models, and the efforts of `model` (empty: its default one). */
  | { type: "loadModels"; agentId: string; model: string };

/** Values equal to the default are removed from settings.json instead of written. */
function isDefault(key: SettingKey, value: unknown): boolean {
  if (key === "language") return value === "auto";
  if (key === "nodePath") return value === "" || value === "node";
  if (key === "checkAgentUpdates") return value === true;
  if (key === "followAgent") return value === false;
  if (key === "autoScroll") return value === true;
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

  static show(context: vscode.ExtensionContext, runtime: AppRuntime, manager: AgentManager["Service"]): void {
    if (SettingsPanel.current) {
      SettingsPanel.current.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel("codeAcp.settings", t("settings.title"), vscode.ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: webviewRoots(context.extensionUri),
    });
    SettingsPanel.current = new SettingsPanel(panel, context, runtime, manager);
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
      manager.onDidChange(() => this.run(this.render)),
      panel.onDidDispose(() => this.dispose()),
    );
  }

  private run<E>(effect: Effect.Effect<void, E, AppServices>): void {
    void runIn(this.runtime, effect, (message) => void vscode.window.showErrorMessage(`Code ACP: ${message}`));
  }

  private readonly onMessage = Effect.fn("SettingsPanel.onMessage")(function* (this: SettingsPanel, msg: FromWebview) {
    switch (msg.type) {
      case "ready":
        yield* this.render;
        break;
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

  private dispose(): void {
    SettingsPanel.current = undefined;
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
