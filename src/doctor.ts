import { Context, Deferred, Effect, FileSystem, Layer, Option, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { spawnAgent } from "./acpClient";
import { AcpTrace } from "./acpTrace";
import { AgentManager, type AgentChoice, type InstallKind } from "./agentManager";
import { CANCELLED } from "./chat/permissions";
import { t } from "./i18n";
import { ExtensionCtx, Output } from "./runtime";
import { readSettings } from "./settings";

/** How long a tool may take to print its version. */
const TOOL_TIMEOUT = "15 seconds";

/** How long a started agent may take to open a session. */
const SESSION_TIMEOUT_SECONDS = 60;

/** Checks running at once; each agent check starts a process. */
const CONCURRENCY = 4;

const NODE_URL = "https://nodejs.org/en/download";
const UV_URL = "https://docs.astral.sh/uv/getting-started/installation/";
const GIT_URL = "https://git-scm.com/downloads";

/** Logs in to the agent id it is given, from a page outside the chat view. */
export const LOGIN_AGENT_COMMAND = "codeAcp.loginAgent";

export type DoctorStatus = "ok" | "warning" | "error";

/** What picking a row does. */
export type DoctorFix =
  | { readonly type: "open"; readonly url: string }
  | { readonly type: "manageAgents" }
  | { readonly type: "login"; readonly agentId: string }
  | { readonly type: "showLog" };

export interface DoctorResult {
  readonly status: DoctorStatus;
  /** Shown next to the name, such as a version. */
  readonly description?: string;
  readonly detail?: string;
  readonly fix?: DoctorFix;
}

export interface DoctorCheck {
  readonly id: string;
  readonly group: "tools" | "agents";
  readonly label: string;
  readonly run: Effect.Effect<DoctorResult>;
}

interface Tool {
  readonly id: string;
  readonly label: string;
  readonly command: string;
  readonly url: string;
  /** Agents of this kind can't run without the tool, which makes its absence an error. */
  readonly neededBy?: InstallKind;
  /** Installing the agents suggested at first run takes it, which makes its absence an error there. */
  readonly neededAtSetup?: boolean;
  readonly missing: string;
}

/** Checks the tools agents depend on, and starts each agent to see that it runs and whether it needs a login. */
export class Doctor extends Context.Service<
  Doctor,
  {
    /** One check per tool and agent, not started yet, so the page can show each as it finishes. */
    readonly checks: Effect.Effect<ReadonlyArray<DoctorCheck>>;
    /** The tools alone, for the first run, when there is no agent to start yet. */
    readonly setupChecks: Effect.Effect<ReadonlyArray<DoctorCheck>>;
  }
>()("code-acp/Doctor") {
  static readonly layer = Layer.effect(
    Doctor,
    Effect.gen(function* () {
      const manager = yield* AgentManager;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fs = yield* FileSystem.FileSystem;
      const output = yield* Output;
      const context = yield* ExtensionCtx;
      const trace = yield* AcpTrace;

      /** The first line `command --version` prints; none when it doesn't run or fails. */
      const versionOf = (command: string) =>
        Effect.gen(function* () {
          const isWindows = process.platform === "win32";
          // On Windows the shell runs .cmd shims such as npm, and would split a path with spaces.
          const handle = yield* spawner.spawn(
            ChildProcess.make(isWindows && command.includes(" ") ? `"${command}"` : command, ["--version"], {
              shell: isWindows,
              stdin: "ignore",
              stderr: "ignore",
              forceKillAfter: "2 seconds",
            }),
          );
          const [stdout, code] = yield* Effect.all(
            [Stream.mkString(Stream.decodeText(handle.stdout)), handle.exitCode],
            {
              concurrency: "unbounded",
            },
          );
          return code === 0 ? Option.some(stdout.trim().split(/\r?\n/)[0] ?? "") : Option.none<string>();
        }).pipe(
          Effect.scoped,
          Effect.timeoutOrElse({ duration: TOOL_TIMEOUT, orElse: () => Effect.succeedNone }),
          Effect.catch((err) =>
            Effect.logInfo(`[doctor] ${command}: ${err.message}`).pipe(Effect.as(Option.none<string>())),
          ),
        );

      const toolCheck = (tool: Tool, needed: boolean): DoctorCheck => ({
        id: tool.id,
        group: "tools",
        label: tool.label,
        run: versionOf(tool.command).pipe(
          Effect.map((version: Option.Option<string>) =>
            Option.match(version, {
              onNone: (): DoctorResult => ({
                status: needed ? "error" : "warning",
                detail: tool.missing,
                fix: { type: "open", url: tool.url },
              }),
              onSome: (description): DoctorResult => ({ status: "ok", description }),
            }),
          ),
        ),
      });

      /** Starts the agent and opens a session, in a folder of its own so it stays out of the project's history. */
      const probe = (choice: AgentChoice, command: Parameters<typeof spawnAgent>[0]) =>
        Effect.gen(function* () {
          const folder = yield* fs.makeTempDirectoryScoped({ prefix: "code-acp-doctor-" });
          const agent = yield* spawnAgent(command, {
            onUpdate: () => {},
            requestPermission: () => Effect.succeed(CANCELLED),
          });
          const session = yield* agent
            .newSession(folder)
            .pipe(Effect.timeoutOption(`${SESSION_TIMEOUT_SECONDS} seconds`));
          if (Option.isNone(session)) {
            return {
              status: "warning",
              description: choice.version,
              detail: t("doctor.agent.timeout", SESSION_TIMEOUT_SECONDS),
              fix: { type: "showLog" },
            } satisfies DoctorResult;
          }
          const { sessionId } = session.value;
          const capabilities = agent.initializeResponse.agentCapabilities?.sessionCapabilities;
          yield* (
            capabilities?.delete
              ? agent.deleteSession(sessionId)
              : capabilities?.close
                ? agent.closeSession(sessionId)
                : Effect.void
          ).pipe(Effect.ignore);
          return { status: "ok", description: choice.version, detail: t("doctor.agent.ok") } satisfies DoctorResult;
        }).pipe(
          Effect.scoped,
          Effect.provideService(Output, output),
          Effect.provideService(ExtensionCtx, context),
          Effect.provideService(AcpTrace, trace),
          Effect.catch((err): Effect.Effect<DoctorResult> =>
            Effect.succeed(
              err._tag === "AuthRequiredError"
                ? {
                    status: "error",
                    description: choice.version,
                    detail: t("doctor.agent.needsLogin"),
                    fix: { type: "login", agentId: choice.id },
                  }
                : { status: "error", description: choice.version, detail: err.message, fix: { type: "showLog" } },
            ),
          ),
        );

      const agentCheck = (choice: AgentChoice): DoctorCheck => ({
        id: `agent:${choice.id}`,
        group: "agents",
        label: choice.name,
        run: manager.command(choice.id).pipe(
          Effect.flatMap((command) =>
            command
              ? probe(choice, command)
              : Effect.succeed<DoctorResult>({
                  status: "warning",
                  detail: t("doctor.agent.none"),
                  fix: { type: "manageAgents" },
                }),
          ),
        ),
      });

      const tools = Effect.sync((): ReadonlyArray<Tool> => {
        const node = readSettings().nodePath || "node";
        return [
          {
            id: "node",
            label: "Node.js",
            command: node,
            url: NODE_URL,
            neededBy: "npx",
            neededAtSetup: true,
            missing: t("doctor.node.missing", node),
          },
          {
            id: "npm",
            label: "npm",
            command: "npm",
            url: NODE_URL,
            neededAtSetup: true,
            missing: t("doctor.npm.missing"),
          },
          { id: "uv", label: "uv", command: "uvx", url: UV_URL, neededBy: "uvx", missing: t("doctor.uv.missing") },
          { id: "git", label: "git", command: "git", url: GIT_URL, missing: t("doctor.git.missing") },
        ];
      });

      return Doctor.of({
        setupChecks: Effect.map(tools, (each) => each.map((tool) => toolCheck(tool, !!tool.neededAtSetup))),
        checks: Effect.gen(function* () {
          const kinds = new Set((yield* manager.list).map((agent) => agent.kind));
          const agents = yield* manager.agents;
          return [
            ...(yield* tools).map((tool) => toolCheck(tool, !!tool.neededBy && kinds.has(tool.neededBy))),
            ...(agents.length
              ? agents.map(agentCheck)
              : [
                  {
                    id: "agents",
                    group: "agents",
                    label: t("doctor.group.agents"),
                    run: Effect.succeed({
                      status: "warning",
                      detail: t("doctor.agent.none"),
                      fix: { type: "manageAgents" },
                    }),
                  } satisfies DoctorCheck,
                ]),
          ];
        }),
      });
    }),
  );
}

export type DoctorMessage =
  | { type: "doctorRun" }
  | { type: "doctorStop" }
  /** Applies the fix of a check's result. */
  | { type: "doctorFix"; id: string };

export interface DoctorRow {
  readonly id: string;
  readonly group: DoctorCheck["group"];
  readonly label: string;
  /** Undefined while the check runs, or when it was stopped first. */
  readonly result?: DoctorResult;
}

export interface DoctorState {
  readonly rows: ReadonlyArray<DoctorRow>;
  readonly running: boolean;
}

/** The checks of the last run with their results so far, for a page that shows them through `post`. */
export class DoctorPage {
  private checks: ReadonlyArray<DoctorCheck> = [];
  private readonly results = new Map<string, DoctorResult>();
  private stopRequest?: Deferred.Deferred<void>;

  constructor(
    private readonly post: (state: DoctorState) => void,
    private readonly loadChecks: Effect.Effect<ReadonlyArray<DoctorCheck>, never, Doctor> = Doctor.use(
      (doctor) => doctor.checks,
    ),
  ) {}

  /** The fix of the check `id`'s result, if any. */
  fixOf(id: string): DoctorFix | undefined {
    return this.results.get(id)?.fix;
  }

  private publish(): void {
    this.post({
      rows: this.checks.map(({ id, group, label }) => ({ id, group, label, result: this.results.get(id) })),
      running: this.stopRequest !== undefined,
    });
  }

  get render(): Effect.Effect<void> {
    return Effect.sync(() => this.publish());
  }

  /** Runs every check from the start, unless a run is going on; ends when they have finished or `stop` is called. */
  readonly run = Effect.fn("DoctorPage.run")(function* (this: DoctorPage) {
    if (this.stopRequest) {
      return;
    }
    const stop = yield* Deferred.make<void>();
    this.stopRequest = stop;
    this.results.clear();
    this.checks = yield* this.loadChecks;
    this.publish();
    const checks = Effect.forEach(
      this.checks,
      ({ id, run }) =>
        run.pipe(
          Effect.tap((result) =>
            Effect.sync(() => {
              this.results.set(id, result);
              this.publish();
            }),
          ),
        ),
      { concurrency: CONCURRENCY, discard: true },
    );
    yield* Effect.raceFirst(checks, Deferred.await(stop)).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          this.stopRequest = undefined;
          this.publish();
        }),
      ),
    );
  });

  /** Stops the run going on, which also stops the agents it started. */
  get stop(): Effect.Effect<void> {
    return Effect.suspend(() =>
      this.stopRequest ? Deferred.succeed(this.stopRequest, undefined).pipe(Effect.asVoid) : Effect.void,
    );
  }
}
