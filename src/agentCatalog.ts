import { Effect, Result } from "effect";
import * as vscode from "vscode";
import { installKind, type AgentManager } from "./agentManager";
import { t } from "./i18n";
import { AcpRegistry, type Registry } from "./registry";
import { thenable } from "./runtime";

/** Where the registry's agent icons are served from; the page showing them allows it in its CSP. */
export const CATALOG_IMG_SRC = "https://cdn.agentclientprotocol.com";

export type CatalogMessage =
  /** The tab is showing: answered with the state, fetching the registry if that hasn't been done. */
  | { type: "catalogLoad" }
  | { type: "catalogRefresh" }
  | { type: "catalogInstall"; id: string }
  | { type: "catalogUninstall"; id: string }
  | { type: "catalogOpen"; url: string };

export interface CatalogAgent {
  id: string;
  name: string;
  version: string;
  description: string;
  icon?: string;
  url?: string;
  license?: string;
  kind?: "npx" | "uvx" | "binary";
  installedVersion?: string;
  active: boolean;
  busy?: string;
}

export interface CatalogState {
  agents: CatalogAgent[];
  loading: boolean;
  error?: string;
}

/** The ACP registry's agents with their install / update / uninstall actions, for a page that shows them through `post`. */
export class AgentCatalog {
  private registry?: Registry;
  private error?: string;
  private loading = false;
  private readonly busy = new Map<string, string>();

  constructor(
    private readonly manager: AgentManager["Service"],
    private readonly post: (state: CatalogState) => void,
  ) {}

  readonly onMessage = Effect.fn("AgentCatalog.onMessage")(function* (this: AgentCatalog, msg: CatalogMessage) {
    switch (msg.type) {
      case "catalogLoad":
        yield* this.render;
        if (!this.registry && !this.loading) {
          yield* this.refresh;
        }
        break;
      case "catalogRefresh":
        yield* this.refresh;
        break;
      case "catalogInstall":
        yield* this.install(msg.id);
        break;
      case "catalogUninstall": {
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
      case "catalogOpen":
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

  private readonly install = Effect.fn("AgentCatalog.install")(function* (this: AgentCatalog, id: string) {
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

  get render(): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const activeId = yield* this.manager.activeId;
      const installed = yield* this.manager.list;
      const versions = new Map(installed.map((a) => [a.id, a.version]));
      this.post({
        agents: (this.registry?.agents ?? []).map((a) => ({
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
        })),
        loading: this.loading,
        error: this.error,
      });
    });
  }
}
