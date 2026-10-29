import { Context, Effect, FileSystem, Layer, Option, Path, Predicate, Schema, Semaphore, Stream } from "effect";
import { HttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { createHash } from "node:crypto";
import * as vscode from "vscode";
import type { AgentCommand } from "./acpClient";
import { t } from "./i18n";
import { binaryTarget, currentPlatform, type BinaryTarget, type PackageDistribution, type RegistryAgent } from "./registry";
import { ExtensionCtx, messageOf, Output, thenable } from "./runtime";
import { CustomAgentEntry, readSettings } from "./settings";

export const InstallKind = Schema.Literals(["npx", "uvx", "binary"]);
export type InstallKind = typeof InstallKind.Type;

export const InstalledAgent = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  version: Schema.String,
  kind: InstallKind,
  icon: Schema.optional(Schema.String),
  command: Schema.String,
  args: Schema.Array(Schema.String),
  env: Schema.Record(Schema.String, Schema.String),
});
export type InstalledAgent = typeof InstalledAgent.Type;

const InstalledAgents = Schema.Record(Schema.String, InstalledAgent);
type InstalledAgents = typeof InstalledAgents.Type;

/** The `bin` field of an npm package.json. */
const PackageJson = Schema.fromJsonString(
  Schema.Struct({
    bin: Schema.optional(Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.String)])),
  }),
);

/** An agent the chat can run: installed from the registry, or one of codeAcp.customAgents (no version). */
export interface AgentChoice {
  readonly id: string;
  readonly name: string;
  readonly version?: string;
}

/** Prefix of the ids of codeAcp.customAgents entries; keeps them apart from registry ids. */
const CUSTOM_PREFIX = "custom:";

const decodeCustomEntries = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown));
const decodeCustomAgent = Schema.decodeUnknownOption(CustomAgentEntry);

/** The usable codeAcp.customAgents entries by id, decoded one by one so a bad entry does not drop the others. */
const customAgents = Effect.sync(() => {
  const raw = vscode.workspace.getConfiguration("codeAcp").get("customAgents");
  const agents = new Map<string, CustomAgentEntry & { readonly name: string }>();
  for (const [name, value] of Object.entries(Option.getOrElse(decodeCustomEntries(raw ?? {}), () => ({})))) {
    const entry = decodeCustomAgent(value);
    if (Option.isSome(entry) && entry.value.command.trim()) {
      agents.set(`${CUSTOM_PREFIX}${name}`, { ...entry.value, name });
    }
  }
  return agents;
});

const INSTALLED_KEY = "codeAcp.installedAgents";
const ACTIVE_KEY = "codeAcp.activeAgent";

type Launch = Pick<InstalledAgent, "command" | "args" | "env">;

export class InstallError extends Schema.TaggedError<InstallError>()("InstallError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/** Picks how to install an agent here: native binary first, then npm, then uv. */
export function installKind(agent: RegistryAgent): InstallKind | undefined {
  if (binaryTarget(agent)) {
    return "binary";
  }
  if (agent.distribution.npx) {
    return "npx";
  }
  if (agent.distribution.uvx) {
    return "uvx";
  }
  return undefined;
}

/** Agents installed from the registry and custom agents from the settings, and which one the chat uses. */
export class AgentManager extends Context.Service<AgentManager, {
  /** Fires when agents are installed or removed, the default changes, or codeAcp.customAgents changes. */
  readonly onDidChange: vscode.Event<void>;
  readonly list: Effect.Effect<ReadonlyArray<InstalledAgent>>;
  get(id: string): Effect.Effect<InstalledAgent | undefined>;
  /** Every agent the chat can run: the installed ones, then the custom ones. */
  readonly agents: Effect.Effect<ReadonlyArray<AgentChoice>>;
  has(id: string): Effect.Effect<boolean>;
  /** Command to launch the agent `id`, installed or custom; undefined when there is no such agent. */
  command(id: string): Effect.Effect<AgentCommand | undefined>;
  /** The default agent for new tabs, while it still exists. */
  readonly activeId: Effect.Effect<string | undefined>;
  readonly active: Effect.Effect<InstalledAgent | undefined>;
  setActive(id: string | undefined): Effect.Effect<void, InstallError>;
  /** Command to launch an installed agent, with the user's extra env applied. */
  commandFor(agent: InstalledAgent): AgentCommand;
  /** Command for the default agent; undefined when there is none. */
  readonly selectedCommand: Effect.Effect<AgentCommand | undefined>;
  install(agent: RegistryAgent, report: (message: string) => Effect.Effect<void>): Effect.Effect<InstalledAgent, InstallError>;
  uninstall(id: string): Effect.Effect<void, InstallError>;
}>()("code-acp/AgentManager") {
  static readonly layer = Layer.effect(
    AgentManager,
    Effect.gen(function* () {
      const context = yield* ExtensionCtx;
      const output = yield* Output;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const http = yield* HttpClient.HttpClient;
      const changed = yield* Effect.acquireRelease(
        Effect.sync(() => new vscode.EventEmitter<void>()),
        (emitter) => Effect.sync(() => emitter.dispose()),
      );
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration("codeAcp.customAgents")) {
              changed.fire();
            }
          }),
        ),
        (listener) => Effect.sync(() => listener.dispose()),
      );
      // Serializes read-modify-write of the installed agents in globalState.
      const stateLock = yield* Semaphore.make(1);
      const root = path.join(context.globalStorageUri.fsPath, "agents");

      const fail = (message: string, cause?: unknown) => new InstallError({ message, cause });
      const removeDir = (dir: string) => fs.remove(dir, { recursive: true, force: true });
      const update = (key: string, value: unknown) =>
        thenable(() => context.globalState.update(key, value)).pipe(Effect.mapError((err) => fail(err.message, err)));

      const state = Effect.sync((): InstalledAgents =>
        Option.getOrElse(Schema.decodeUnknownOption(InstalledAgents)(context.globalState.get(INSTALLED_KEY)), () => ({})),
      );
      const has = (id: string) =>
        Effect.gen(function* () {
          return !!(yield* state)[id] || (yield* customAgents).has(id);
        });
      const activeId = Effect.gen(function* () {
        const id = context.globalState.get(ACTIVE_KEY);
        return Predicate.isString(id) && (yield* has(id)) ? id : undefined;
      });
      const notify = Effect.sync(() => changed.fire());

      /** Runs a command, streaming its output to the log; fails unless it exits with code 0. */
      const run = Effect.fn("AgentManager.run")(
        function* (command: string, args: ReadonlyArray<string>) {
          yield* Effect.logInfo(`[install] ${command} ${args.join(" ")}`);
          const handle = yield* spawner
            .spawn(ChildProcess.make(command, args, { shell: process.platform === "win32" }))
            .pipe(Effect.mapError((err) => fail(t("install.spawnFailed", command, err.message), err)));
          yield* handle.all.pipe(
            Stream.decodeText(),
            Stream.runForEach((text) => Effect.sync(() => output.append(text))),
            Effect.mapError((err) => fail(t("install.spawnFailed", command, err.message), err)),
          );
          const code = yield* handle.exitCode.pipe(
            Effect.mapError((err) => fail(t("install.spawnFailed", command, err.message), err)),
          );
          if (code !== 0) {
            return yield* fail(t("install.exitCode", command, code));
          }
        },
        Effect.scoped,
      );

      const installNpm = Effect.fn("AgentManager.installNpm")(function* (
        dist: PackageDistribution,
        dir: string,
        report: (message: string) => Effect.Effect<void>,
      ) {
        yield* report(t("install.npm", dist.package));
        yield* run("npm", ["install", "--prefix", dir, "--no-audit", "--no-fund", "--omit=dev", dist.package]);

        // "@scope/name@1.2.3" -> "@scope/name"
        const at = dist.package.lastIndexOf("@");
        const name = at > 0 ? dist.package.slice(0, at) : dist.package;
        const pkgDir = path.join(dir, "node_modules", name);
        const pkg = yield* fs.readFileString(path.join(pkgDir, "package.json")).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(PackageJson)),
          Effect.mapError((err) => fail(t("install.noBin", name), err)),
        );
        const bins = Predicate.isString(pkg.bin) ? { [path.basename(name)]: pkg.bin } : (pkg.bin ?? {});
        const bin = bins[path.basename(name)] ?? Object.values(bins)[0];
        if (!bin) {
          return yield* fail(t("install.noBin", name));
        }
        const node = readSettings().nodePath || "node";
        return { command: node, args: [path.join(pkgDir, bin), ...(dist.args ?? [])], env: dist.env ?? {} } satisfies Launch;
      });

      const installBinary = Effect.fn("AgentManager.installBinary")(function* (
        target: BinaryTarget,
        dir: string,
        report: (message: string) => Effect.Effect<void>,
      ) {
        const url = new URL(target.archive);
        const fileName = path.basename(url.pathname);
        const file = path.join(dir, fileName);

        yield* report(t("install.download", fileName));
        const res = yield* http.get(url).pipe(Effect.mapError((err) => fail(t("install.downloadFailed", url, err.message), err)));
        if (res.status < 200 || res.status >= 300) {
          return yield* fail(t("install.downloadFailed", url, res.status));
        }
        const data = new Uint8Array(
          yield* res.arrayBuffer.pipe(Effect.mapError((err) => fail(t("install.downloadFailed", url, err.message), err))),
        );
        if (target.sha256) {
          const digest = createHash("sha256").update(data).digest("hex");
          if (digest.toLowerCase() !== target.sha256.toLowerCase()) {
            return yield* fail(t("install.checksum", url));
          }
        }
        yield* fs.writeFile(file, data);

        yield* report(t("install.extract"));
        const lower = file.toLowerCase();
        if (lower.endsWith(".zip")) {
          // bsdtar (macOS, Windows) reads zip; GNU tar on Linux does not.
          yield* process.platform === "linux"
            ? run("unzip", ["-o", "-q", file, "-d", dir])
            : run("tar", ["-xf", file, "-C", dir]);
          yield* fs.remove(file);
        } else if (/\.(tar\.gz|tgz|tar\.bz2|tbz2)$/.test(lower)) {
          yield* run("tar", ["-xf", file, "-C", dir]);
          yield* fs.remove(file);
        } else {
          // Raw binary: store it under the name the registry runs.
          yield* fs.rename(file, path.join(dir, target.cmd));
        }

        const cmd = path.resolve(dir, target.cmd);
        if (process.platform !== "win32") {
          yield* fs.chmod(cmd, 0o755);
        }
        return { command: cmd, args: target.args ?? [], env: target.env ?? {} } satisfies Launch;
      });

      const install = Effect.fn("AgentManager.install")(function* (
        agent: RegistryAgent,
        report: (message: string) => Effect.Effect<void>,
      ) {
        const kind = installKind(agent);
        if (!kind) {
          return yield* fail(t("install.unsupported", agent.name, currentPlatform() ?? process.platform));
        }
        const dir = path.join(root, agent.id, agent.version);
        yield* removeDir(dir);
        yield* fs.makeDirectory(dir, { recursive: true });

        const launch = yield* Effect.gen(function* () {
          const binary = binaryTarget(agent);
          const { npx, uvx } = agent.distribution;
          if (kind === "binary" && binary) {
            return yield* installBinary(binary, dir, report);
          }
          if (kind === "npx" && npx) {
            return yield* installNpm(npx, dir, report);
          }
          if (uvx) {
            yield* report(t("install.checkUvx"));
            yield* run("uvx", ["--version"]);
            return { command: "uvx", args: [uvx.package, ...(uvx.args ?? [])], env: uvx.env ?? {} } satisfies Launch;
          }
          return yield* fail(t("install.unsupported", agent.name, currentPlatform() ?? process.platform));
        }).pipe(Effect.onError(() => removeDir(dir).pipe(Effect.ignore)));

        const installed: InstalledAgent = {
          id: agent.id,
          name: agent.name,
          version: agent.version,
          kind,
          icon: agent.icon,
          ...launch,
        };
        const previous = yield* Semaphore.withPermits(stateLock, 1)(
          Effect.gen(function* () {
            const current = yield* state;
            yield* update(INSTALLED_KEY, { ...current, [agent.id]: installed });
            if (!(yield* activeId)) {
              yield* update(ACTIVE_KEY, agent.id);
            }
            return current[agent.id];
          }),
        );
        if (previous && previous.version !== agent.version) {
          yield* removeDir(path.join(root, agent.id, previous.version));
        }
        yield* notify;
        return installed;
      }, Effect.mapError((err) => (err instanceof InstallError ? err : fail(messageOf(err), err))));

      const uninstall = Effect.fn("AgentManager.uninstall")(function* (id: string) {
        yield* removeDir(path.join(root, id)).pipe(Effect.mapError((err) => fail(err.message, err)));
        yield* Semaphore.withPermits(stateLock, 1)(
          Effect.gen(function* () {
            const { [id]: _removed, ...rest } = yield* state;
            yield* update(INSTALLED_KEY, rest);
            if (context.globalState.get(ACTIVE_KEY) === id) {
              yield* update(ACTIVE_KEY, Object.keys(rest)[0]);
            }
          }),
        );
        yield* notify;
      });

      const commandFor = (agent: InstalledAgent): AgentCommand => ({
        command: agent.command,
        args: agent.args,
        env: { ...agent.env, ...readSettings().env },
      });

      const command = Effect.fn("AgentManager.command")(function* (id: string) {
        const installed = (yield* state)[id];
        if (installed) {
          return commandFor(installed);
        }
        const custom = (yield* customAgents).get(id);
        return custom
          ? ({
              command: custom.command.trim(),
              args: custom.args ?? [],
              env: { ...readSettings().env, ...custom.env },
            } satisfies AgentCommand)
          : undefined;
      });

      return AgentManager.of({
        onDidChange: changed.event,
        list: Effect.map(state, Object.values),
        get: (id) => Effect.map(state, (agents) => agents[id]),
        agents: Effect.gen(function* () {
          const installed = Object.values(yield* state).map(({ id, name, version }): AgentChoice => ({ id, name, version }));
          const custom = [...(yield* customAgents)].map(([id, { name }]): AgentChoice => ({ id, name }));
          return [...installed, ...custom];
        }),
        has,
        command,
        activeId,
        active: Effect.gen(function* () {
          const id = yield* activeId;
          return id ? (yield* state)[id] : undefined;
        }),
        setActive: (id) => update(ACTIVE_KEY, id).pipe(Effect.andThen(notify)),
        commandFor,
        selectedCommand: Effect.gen(function* () {
          const id = yield* activeId;
          return id ? yield* command(id) : undefined;
        }),
        install,
        uninstall,
      });
    }),
  );
}
