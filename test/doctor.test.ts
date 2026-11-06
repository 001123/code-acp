import { NodeFileSystem, NodePath } from "@effect/platform-node-shared";
import * as NodeChildProcessSpawner from "@effect/platform-node-shared/NodeChildProcessSpawner";
import { assert, beforeEach, describe, it } from "@effect/vitest";
import { Effect, Fiber, Layer } from "effect";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentManager, type AgentChoice, type InstalledAgent } from "../src/agentManager";
import {
  Doctor,
  DoctorPage,
  LOGIN_AGENT_COMMAND,
  type DoctorCheck,
  type DoctorResult,
  type DoctorState,
} from "../src/doctor";
import { makeRuntime } from "../src/runtime";
import { SettingsPanel } from "../src/settingsPanel";
import type * as vscode from "vscode";
import { makeOutput, stubLayer } from "./helpers";
import { __test, commands, Uri } from "./stubs/vscode";

const MOCK_AGENT = fileURLToPath(new URL("./fixtures/mock-agent.mjs", import.meta.url));

/** Makes `names` the only commands on PATH, each printing its version. */
const onPath = (...names: ReadonlyArray<string>) => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "code-acp-doctor-bin-"));
  for (const name of names) {
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho "${name} 1.2.3"\necho second line\n`, { mode: 0o755 });
  }
  process.env.PATH = bin;
};

const managerWith = (
  agents: ReadonlyArray<AgentChoice>,
  kinds: ReadonlyArray<InstalledAgent["kind"]> = [],
  env: Record<string, string> = {},
) =>
  ({
    agents: Effect.succeed(agents),
    list: Effect.succeed(kinds.map((kind) => ({ kind }) as InstalledAgent)),
    command: () => Effect.succeed({ command: process.execPath, args: [MOCK_AGENT], env }),
  }) as unknown as AgentManager["Service"];

const doctorLayer = (manager: AgentManager["Service"]) =>
  Doctor.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(AgentManager, manager),
        stubLayer(makeOutput()),
        NodeChildProcessSpawner.layer.pipe(Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))),
      ),
    ),
  );

/** Runs every check; results by id. */
const runChecks = (manager: AgentManager["Service"]) =>
  Effect.gen(function* () {
    const checks = yield* Doctor.use((doctor) => doctor.checks);
    return new Map(
      yield* Effect.forEach(checks, (check) => check.run.pipe(Effect.map((result) => [check.id, result] as const))),
    );
  }).pipe(Effect.provide(doctorLayer(manager)));

const PATH = process.env.PATH;

beforeEach(() => {
  __test.reset();
  return () => {
    process.env.PATH = PATH;
  };
});

describe("tools", () => {
  it.live("reports each tool's version", () =>
    Effect.gen(function* () {
      onPath("node", "npm", "uvx", "git");
      const results = yield* runChecks(managerWith([]));
      for (const [id, command] of [
        ["node", "node"],
        ["npm", "npm"],
        ["uv", "uvx"],
        ["git", "git"],
      ] as const) {
        assert.deepStrictEqual(results.get(id), { status: "ok", description: `${command} 1.2.3` });
      }
    }),
  );

  it.live("uses the Node path from the settings", () =>
    Effect.gen(function* () {
      onPath();
      __test.setSetting("codeAcp.nodePath", process.execPath);
      const node = (yield* runChecks(managerWith([]))).get("node");
      assert.strictEqual(node?.status, "ok");
      assert.strictEqual(node?.description, process.version);
    }),
  );

  it.live("a missing tool is a warning until an installed agent needs it", () =>
    Effect.gen(function* () {
      onPath();
      const free = yield* runChecks(managerWith([]));
      assert.strictEqual(free.get("uv")?.status, "warning");
      assert.strictEqual(free.get("node")?.status, "warning");
      assert.deepStrictEqual(free.get("uv")?.fix, {
        type: "open",
        url: "https://docs.astral.sh/uv/getting-started/installation/",
      });

      const needed = yield* runChecks(managerWith([], ["uvx", "npx"]));
      assert.strictEqual(needed.get("uv")?.status, "error");
      assert.strictEqual(needed.get("node")?.status, "error");
      // Only installing needs these.
      assert.strictEqual(needed.get("npm")?.status, "warning");
      assert.strictEqual(needed.get("git")?.status, "warning");
    }),
  );

  it.live("a tool that fails counts as missing", () =>
    Effect.gen(function* () {
      onPath();
      const bin = process.env.PATH!;
      fs.writeFileSync(path.join(bin, "git"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      assert.strictEqual((yield* runChecks(managerWith([]))).get("git")?.status, "warning");
    }),
  );
});

describe("agents", () => {
  const mock: AgentChoice = { id: "mock", name: "Mock", version: "1.0.0" };

  it.live("offers to install an agent when there is none", () =>
    Effect.gen(function* () {
      onPath();
      const results = yield* runChecks(managerWith([]));
      assert.deepStrictEqual(results.get("agents")?.fix, { type: "manageAgents" });
    }),
  );

  it.live("starts the agent and opens a session outside the project, then deletes it", () =>
    Effect.gen(function* () {
      onPath();
      const record = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "code-acp-doctor-record-")), "record");
      const results = yield* runChecks(managerWith([mock], [], { MOCK_HISTORY: "1", MOCK_RECORD: record }));
      assert.deepStrictEqual(results.get("agent:mock"), {
        status: "ok",
        description: "1.0.0",
        detail: "Started and opened a session.",
      });
      const [created, deleted] = fs.readFileSync(record, "utf8").trim().split("\n");
      const folder = created!.split(" ").slice(2).join(" ");
      assert.include(path.basename(folder), "code-acp-doctor-");
      assert.isFalse(fs.existsSync(folder));
      assert.strictEqual(deleted, "delete s1");
    }),
  );

  it.live("asks for a login when the agent wants one", () =>
    Effect.gen(function* () {
      onPath();
      const result = (yield* runChecks(managerWith([mock], [], { MOCK_AUTH: "1" }))).get("agent:mock");
      assert.strictEqual(result?.status, "error");
      assert.deepStrictEqual(result?.fix, { type: "login", agentId: "mock" });
    }),
  );

  it.live("reports an agent that does not start, and points at the log", () =>
    Effect.gen(function* () {
      onPath();
      const result = (yield* runChecks(managerWith([mock], [], { MOCK_EXIT_EARLY: "1" }))).get("agent:mock");
      assert.strictEqual(result?.status, "error");
      assert.include(result?.detail, "3");
      assert.deepStrictEqual(result?.fix, { type: "showLog" });
    }),
  );
});

const check = (
  id: string,
  group: DoctorCheck["group"],
  run: Effect.Effect<DoctorResult> = Effect.never,
): DoctorCheck => ({
  id,
  group,
  label: id,
  run,
});

describe("Doctor.setupChecks", () => {
  const runSetupChecks = Effect.gen(function* () {
    const checks = yield* Doctor.use((doctor) => doctor.setupChecks);
    return new Map(
      yield* Effect.forEach(checks, (check) => check.run.pipe(Effect.map((result) => [check.id, result] as const))),
    );
  }).pipe(Effect.provide(doctorLayer(managerWith([]))));

  it.live("checks the tools alone: there is no agent to start yet", () =>
    Effect.gen(function* () {
      onPath("node", "npm", "uvx", "git");
      const results = yield* runSetupChecks;
      assert.deepStrictEqual([...results.keys()], ["node", "npm", "uv", "git"]);
      assert.isTrue([...results.values()].every((result) => result.status === "ok"));
    }),
  );

  it.live("fails without Node.js or npm, which installing the suggested agents takes", () =>
    Effect.gen(function* () {
      onPath("uvx", "git");
      const results = yield* runSetupChecks;
      assert.strictEqual(results.get("node")?.status, "error");
      assert.strictEqual(results.get("npm")?.status, "error");
      assert.strictEqual(results.get("npm")?.fix?.type, "open");
    }),
  );

  it.live("only warns without uv or git", () =>
    Effect.gen(function* () {
      onPath("node", "npm");
      const results = yield* runSetupChecks;
      assert.strictEqual(results.get("node")?.status, "ok");
      assert.strictEqual(results.get("uv")?.status, "warning");
      assert.strictEqual(results.get("git")?.status, "warning");
    }),
  );
});

describe("DoctorPage", () => {
  const withChecks = (checks: ReadonlyArray<DoctorCheck>) =>
    Layer.succeed(Doctor, Doctor.of({ checks: Effect.succeed(checks), setupChecks: Effect.succeed([]) }));
  const fix = { type: "showLog" } as const;
  const makePage = () => {
    const states: Array<DoctorState> = [];
    return { states, page: new DoctorPage((state) => void states.push(state)) };
  };

  it.live("runs the checks it was given instead of all of them", () =>
    Effect.gen(function* () {
      const states: Array<DoctorState> = [];
      const page = new DoctorPage(
        (state) => void states.push(state),
        Doctor.use((doctor) => doctor.setupChecks),
      );
      const setup = Layer.succeed(
        Doctor,
        Doctor.of({
          checks: Effect.succeed([]),
          setupChecks: Effect.succeed([check("node", "tools", Effect.succeed({ status: "ok" }))]),
        }),
      );
      yield* page.run().pipe(Effect.provide(setup));
      assert.deepStrictEqual(
        states.at(-1)?.rows.map((row) => row.id),
        ["node"],
      );
    }),
  );

  it.live("shows each result as it comes, then that it finished", () =>
    Effect.gen(function* () {
      const { states, page } = makePage();
      yield* page
        .run()
        .pipe(
          Effect.provide(
            withChecks([
              check("git", "tools", Effect.succeed({ status: "warning", fix })),
              check("claude", "agents", Effect.succeed({ status: "ok" })),
            ]),
          ),
        );
      assert.deepStrictEqual(
        states[0]?.rows.map((row) => [row.id, row.group, row.result]),
        [
          ["git", "tools", undefined],
          ["claude", "agents", undefined],
        ],
      );
      assert.isTrue(states[0]?.running);
      const last = states.at(-1)!;
      assert.isFalse(last.running);
      assert.deepStrictEqual(
        last.rows.map((row) => row.result?.status),
        ["warning", "ok"],
      );
      assert.deepStrictEqual(page.fixOf("git"), fix);
      assert.isUndefined(page.fixOf("claude"));
    }),
  );

  it.live("stop ends the checks still running, and keeps what is known", () =>
    Effect.gen(function* () {
      const { states, page } = makePage();
      let stopped = false;
      const slow = Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => void (stopped = true))));
      const run = yield* page
        .run()
        .pipe(
          Effect.provide(
            withChecks([check("git", "tools", Effect.succeed({ status: "ok" })), check("claude", "agents", slow)]),
          ),
          Effect.forkChild,
        );
      yield* Effect.sleep("10 millis");
      assert.isTrue(states.at(-1)?.running);
      yield* page.stop;
      yield* Fiber.join(run);
      assert.isTrue(stopped);
      const last = states.at(-1)!;
      assert.isFalse(last.running);
      assert.deepStrictEqual(
        last.rows.map((row) => row.result?.status),
        ["ok", undefined],
      );
    }),
  );

  it.live("a run going on ignores another; the next one starts over", () =>
    Effect.gen(function* () {
      const { states, page } = makePage();
      let runs = 0;
      const counted = Effect.suspend(() => {
        runs++;
        return Effect.succeed<DoctorResult>({ status: "error", fix });
      });
      const layer = withChecks([check("git", "tools", counted), check("claude", "agents")]);
      const first = yield* page.run().pipe(Effect.provide(layer), Effect.forkChild);
      yield* Effect.sleep("10 millis");
      yield* page.run().pipe(Effect.provide(layer));
      assert.strictEqual(runs, 1);
      yield* page.stop;
      yield* Fiber.join(first);
      assert.strictEqual(states.at(-1)?.rows[0]?.result?.status, "error");

      yield* page.run().pipe(Effect.provide(withChecks([check("claude", "agents", Effect.succeed({ status: "ok" }))])));
      assert.deepStrictEqual(
        states.at(-1)?.rows.map((row) => row.id),
        ["claude"],
      );
      assert.isUndefined(page.fixOf("git"));
    }),
  );

  it.live("stopping with nothing running does nothing", () => makePage().page.stop);
});

describe("the Doctor tab of the settings page", () => {
  /** The page on the real services, opened as `open` says, with the custom agents given. */
  const openPage = (customAgents: unknown, open?: { tab: string; section: string }) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        onPath();
        __test.setSetting("codeAcp.customAgents", customAgents);
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "code-acp-doctor-page-"));
        const store = new Map<string, unknown>();
        const memento = {
          get: (key: string) => store.get(key),
          update: async (key: string, value: unknown) => void store.set(key, value),
        };
        const context = {
          extensionUri: Uri.file(root),
          globalStorageUri: Uri.file(path.join(root, "global")),
          workspaceState: memento,
          globalState: memento,
          extension: { id: "test.code-acp", packageJSON: { version: "1.2.3" } },
        } as unknown as vscode.ExtensionContext;
        const runtime = makeRuntime(context, makeOutput());
        const manager = {
          agents: Effect.succeed([]),
          activeId: Effect.succeed(undefined),
          onDidChange: () => ({ dispose: () => {} }),
        } as unknown as AgentManager["Service"];
        SettingsPanel.show(context, runtime, manager, open?.tab, open?.section);
        const panel = __test.panels[0]!;
        const state = () => panel.posted.filter((m) => m.type === "doctor").at(-1)?.doctor as DoctorState | undefined;
        return { panel, runtime, state };
      }),
      ({ panel, runtime }) =>
        Effect.promise(async () => {
          panel.close();
          await runtime.dispose();
        }),
    );

  const until = (ready: () => boolean, what: string) =>
    Effect.gen(function* () {
      for (let waited = 0; !ready(); waited++) {
        if (waited > 3000) {
          return yield* Effect.die(`Timed out waiting for ${what}`);
        }
        yield* Effect.sleep("2 millis");
      }
    });

  it.live("starts nothing until the page asks", () =>
    Effect.gen(function* () {
      const { panel, state } = yield* openPage({}, { tab: "doctor", section: "run" });
      panel.receive({ type: "ready" });
      yield* until(() => state() !== undefined, "the page's state");
      assert.deepInclude(
        panel.posted.find((m) => m.type === "selectTab"),
        { tab: "doctor", section: "run" },
      );
      assert.deepStrictEqual(state(), { rows: [], running: false });
    }),
  );

  it.live("runs, and applies the fixes the results offer", () =>
    Effect.gen(function* () {
      const { panel, state } = yield* openPage({
        mock: { command: process.execPath, args: [MOCK_AGENT], env: { MOCK_AUTH: "1" } },
      });
      panel.receive({ type: "doctorRun" });
      yield* until(() => !!state()?.rows.length && !state()?.running, "the checks");
      const agent = state()!.rows.find((row) => row.id === "agent:custom:mock");
      assert.deepStrictEqual(agent?.result?.fix, { type: "login", agentId: "custom:mock" });

      const executed: Array<ReadonlyArray<unknown>> = [];
      const executeCommand = commands.executeCommand;
      commands.executeCommand = async (...args) => void executed.push(args);
      yield* Effect.addFinalizer(() => Effect.sync(() => (commands.executeCommand = executeCommand)));

      panel.receive({ type: "doctorFix", id: "agent:custom:mock" });
      yield* until(() => executed.length === 1, "the login");
      assert.deepStrictEqual(executed[0], [LOGIN_AGENT_COMMAND, "custom:mock"]);

      panel.receive({ type: "doctorFix", id: "uv" });
      yield* until(() => __test.openedExternal.length === 1, "the download page");
      assert.include(String(__test.openedExternal[0]), "https://docs.astral.sh/uv/getting-started/installation/");

      // An id without a result is ignored.
      panel.receive({ type: "doctorFix", id: "nothing" });
      yield* Effect.sleep("10 millis");
      assert.lengthOf(executed, 1);
    }),
  );

  it.live("offers Manage agents by moving the page to it", () =>
    Effect.gen(function* () {
      const { panel, state } = yield* openPage({});
      panel.receive({ type: "doctorRun" });
      yield* until(() => !!state()?.rows.length && !state()?.running, "the checks");
      panel.receive({ type: "doctorFix", id: "agents" });
      yield* until(() => panel.posted.some((m) => m.type === "selectTab"), "the Agent tab");
      assert.deepInclude(
        panel.posted.find((m) => m.type === "selectTab"),
        { tab: "agent", section: "manage" },
      );
    }),
  );

  it.live("closing the page stops the run", () =>
    Effect.gen(function* () {
      const { panel, state } = yield* openPage({
        // Never answers `initialize`.
        hung: { command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] },
      });
      panel.receive({ type: "doctorRun" });
      yield* until(() => state()?.running === true, "the run");
      const before = panel.posted.length;
      panel.close();
      yield* Effect.sleep("50 millis");
      // Closed pages get no more state.
      assert.lengthOf(panel.posted, before);
    }),
  );
});
