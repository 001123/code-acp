import { Context, Effect, Layer, Result } from "effect";
import * as vscode from "vscode";
import { AgentManager, installKind, type InstalledAgent } from "./agentManager";
import { t } from "./i18n";
import { AcpRegistry, type RegistryAgent } from "./registry";
import { messageOf, thenable } from "./runtime";
import { readSettings } from "./settings";

/** An installed agent whose registry entry has a different (newer) version. */
export interface AgentUpdate {
  readonly installed: InstalledAgent;
  readonly latest: RegistryAgent;
}

/** Finds registry updates for installed agents and installs them. */
export class AgentUpdates extends Context.Service<AgentUpdates, {
  /**
   * Looks for updates in the registry, unless checks are off (codeAcp.checkAgentUpdates). Returns the ones to
   * notify about: those not yet offered since the window opened; empty when the registry cannot be loaded.
   */
  readonly due: Effect.Effect<ReadonlyArray<AgentUpdate>>;
  /** Updates the last check found that are still not installed. */
  readonly pending: Effect.Effect<ReadonlyArray<AgentUpdate>>;
  /** Fires when a check finds a different set of registry versions. */
  readonly onDidChange: vscode.Event<void>;
  /** Installs the updates one by one behind a progress notification, reports failures and returns the agents updated. */
  install(updates: ReadonlyArray<AgentUpdate>): Effect.Effect<ReadonlyArray<RegistryAgent>>;
}>()("code-acp/AgentUpdates") {
  static readonly layer = Layer.effect(
    AgentUpdates,
    Effect.gen(function* () {
      const manager = yield* AgentManager;
      const registry = yield* AcpRegistry;

      const changed = new vscode.EventEmitter<void>();
      yield* Effect.addFinalizer(() => Effect.sync(() => changed.dispose()));
      /** Registry entries of installed agents, by id, as of the last check. */
      let latest = new Map<string, RegistryAgent>();
      /** `id@version` of the updates already offered in this window. */
      const offered = new Set<string>();

      const pending = Effect.gen(function* () {
        return (yield* manager.list).flatMap((installed): Array<AgentUpdate> => {
          const agent = latest.get(installed.id);
          return agent && agent.version !== installed.version && installKind(agent) ? [{ installed, latest: agent }] : [];
        });
      });

      const check = Effect.gen(function* () {
        const agents = (yield* registry.fetch).agents;
        const before = [...latest.values()].map((a) => `${a.id}@${a.version}`).join();
        latest = new Map(agents.map((a) => [a.id, a]));
        if ([...latest.values()].map((a) => `${a.id}@${a.version}`).join() !== before) {
          changed.fire();
        }
      });

      const due = Effect.gen(function* () {
        if (!readSettings().checkAgentUpdates) {
          return [];
        }
        yield* check;
        const updates = (yield* pending).filter((u) => !offered.has(`${u.latest.id}@${u.latest.version}`));
        for (const u of updates) {
          offered.add(`${u.latest.id}@${u.latest.version}`);
        }
        return updates;
      }).pipe(
        Effect.catch((err) => Effect.logWarning(`[updates] check failed: ${messageOf(err)}`).pipe(Effect.as([]))),
        Effect.withSpan("AgentUpdates.due"),
      );

      const install = Effect.fn("AgentUpdates.install")(function* (updates: ReadonlyArray<AgentUpdate>) {
        const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
        const installAll = (progress: vscode.Progress<{ message?: string }>) =>
          Effect.forEach(updates, ({ latest }) =>
            manager
              .install(latest, (message) => Effect.sync(() => progress.report({ message: `${latest.name}: ${message}` })))
              .pipe(Effect.result, Effect.map((result) => ({ agent: latest, result }))),
          );
        const results = yield* thenable(() =>
          vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: t("updates.progress") },
            (progress) => runPromise(installAll(progress)),
          ),
        ).pipe(Effect.orDie);

        for (const { agent, result } of results) {
          if (Result.isFailure(result)) {
            void vscode.window.showErrorMessage(t("manager.installFailed", agent.name, result.failure.message));
          }
        }
        return results.flatMap(({ agent, result }) => (Result.isSuccess(result) ? [agent] : []));
      });

      return AgentUpdates.of({ due, pending, onDidChange: changed.event, install });
    }),
  );
}
