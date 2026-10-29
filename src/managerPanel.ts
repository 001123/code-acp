import { Effect, Result } from "effect";
import * as vscode from "vscode";
import { installKind, type AgentManager } from "./agentManager";
import { onDidChangeLocale, t, webviewL10n } from "./i18n";
import { AcpRegistry, type Registry } from "./registry";
import { runIn, thenable, type AppRuntime, type AppServices } from "./runtime";
import { webviewHtml, webviewRoots } from "./webview";

export type FromWebview =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "install"; id: string }
  | { type: "uninstall"; id: string }
  | { type: "use"; id: string }
  | { type: "open"; url: string };

/** Webview page listing ACP registry agents with install / update / uninstall / use actions. */
export class ManagerPanel {
  private static current?: ManagerPanel;

  private registry?: Registry;
  private error?: string;
  private loading = false;
  private readonly busy = new Map<string, string>();
  private readonly disposables: vscode.Disposable[] = [];

  static show(context: vscode.ExtensionContext, runtime: AppRuntime, manager: AgentManager["Service"]): void {
    if (ManagerPanel.current) {
      ManagerPanel.current.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel("codeAcp.manager", "ACP Agents", vscode.ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: webviewRoots(context.extensionUri),
    });
    ManagerPanel.current = new ManagerPanel(panel, context, runtime, manager);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly runtime: AppRuntime,
    private readonly manager: AgentManager["Service"],
  ) {
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "icon.svg");
    panel.webview.html = webviewHtml(panel.webview, context.extensionUri, "manager", "https://cdn.agentclientprotocol.com");
    this.disposables.push(
      panel.webview.onDidReceiveMessage((msg: FromWebview) => this.run(this.onMessage(msg))),
      manager.onDidChange(() => this.run(this.render)),
      onDidChangeLocale(() => void panel.webview.postMessage(webviewL10n())),
      panel.onDidDispose(() => this.dispose()),
    );
  }

  private run<E>(effect: Effect.Effect<void, E, AppServices>): void {
    void runIn(this.runtime, effect, (message) => void vscode.window.showErrorMessage(`Code ACP: ${message}`));
  }

  private readonly onMessage = Effect.fn("ManagerPanel.onMessage")(function* (this: ManagerPanel, msg: FromWebview) {
    switch (msg.type) {
      case "ready":
        yield* this.render;
        if (!this.registry) {
          yield* this.refresh;
        }
        break;
      case "refresh":
        yield* this.refresh;
        break;
      case "install":
        yield* this.install(msg.id);
        break;
      case "uninstall": {
        const agent = yield* this.manager.get(msg.id);
        const ok = yield* thenable(() =>
          vscode.window.showWarningMessage(
            t("manager.uninstallConfirm", agent?.name ?? msg.id),
            { modal: true },
            t("manager.uninstall"),
          ),
        );
        if (ok) {
          yield* this.manager.uninstall(msg.id);
        }
        break;
      }
      case "use":
        yield* this.manager.setActive(msg.id);
        break;
      case "open":
        if (/^https:\/\//.test(msg.url)) {
          yield* thenable(() => vscode.env.openExternal(vscode.Uri.parse(msg.url)));
        }
        break;
    }
  });

  private get refresh(): Effect.Effect<void, never, AcpRegistry> {
    return Effect.gen({ self: this }, function* () {
      this.loading = true;
      yield* this.render;
      const result = yield* AcpRegistry.use((registry) => registry.fetch).pipe(Effect.result);
      if (Result.isSuccess(result)) {
        this.registry = result.success;
        this.error = undefined;
      } else {
        this.error = result.failure.message;
      }
      this.loading = false;
      yield* this.render;
    });
  }

  private readonly install = Effect.fn("ManagerPanel.install")(function* (this: ManagerPanel, id: string) {
    const agent = this.registry?.agents.find((a) => a.id === id);
    if (!agent || this.busy.has(id)) {
      return;
    }
    const report = (message: string) =>
      Effect.suspend(() => {
        this.busy.set(id, message);
        return this.render;
      });
    yield* report(t("manager.installing"));
    yield* this.manager.install(agent, report).pipe(
      Effect.match({
        onSuccess: () => void vscode.window.showInformationMessage(t("manager.installed", agent.name, agent.version)),
        onFailure: (err) => void vscode.window.showErrorMessage(t("manager.installFailed", agent.name, err.message)),
      }),
      Effect.ensuring(
        Effect.suspend(() => {
          this.busy.delete(id);
          return this.render;
        }),
      ),
    );
  });

  private get render(): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const activeId = yield* this.manager.activeId;
      const installed = yield* this.manager.list;
      const versions = new Map(installed.map((a) => [a.id, a.version]));
      const agents = (this.registry?.agents ?? []).map((a) => ({
        id: a.id,
        name: a.name,
        version: a.version,
        description: a.description,
        icon: a.icon,
        url: a.website ?? a.repository,
        license: a.license,
        kind: installKind(a),
        installedVersion: versions.get(a.id),
        active: a.id === activeId,
        busy: this.busy.get(a.id),
      }));
      void this.panel.webview.postMessage({
        type: "state",
        agents,
        loading: this.loading,
        error: this.error,
      });
    });
  }

  private dispose(): void {
    ManagerPanel.current = undefined;
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
