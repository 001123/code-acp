import * as NodeChildProcessSpawner from "@effect/platform-node-shared/NodeChildProcessSpawner";
import { NodeFileSystem, NodePath } from "@effect/platform-node-shared";
import { assert, beforeEach, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { createHash } from "node:crypto";
import type * as vscode from "vscode";
import { AgentManager } from "../src/agentManager";
import { isPathSegment, Platform, type BinaryTarget, type RegistryAgent } from "../src/registry";
import { ExtensionCtx, Output } from "../src/runtime";
import { makeOutput } from "./helpers";
import { window } from "./stubs/vscode";

const CONTENT = "#!/bin/sh\n";
const CHECKSUM = createHash("sha256").update(CONTENT).digest("hex");

const warnings: Array<string> = [];
const showWarningMessage = window.showWarningMessage;

beforeEach(() => {
  warnings.length = 0;
  window.showWarningMessage = async (message: string) => {
    warnings.push(message);
    return undefined;
  };
  return () => {
    window.showWarningMessage = showWarningMessage;
  };
});

const binaryAgent = (target: Partial<BinaryTarget>, agent: Partial<RegistryAgent> = {}): RegistryAgent => ({
  id: "tool",
  name: "Tool",
  version: "1.0.0",
  description: "Binary agent",
  distribution: {
    binary: Object.fromEntries(
      Platform.literals.map((platform) => [
        platform,
        { archive: "https://a/tool", cmd: "./tool", sha256: CHECKSUM, ...target },
      ]),
    ),
  },
  ...agent,
});

const makeContext = (storage: string, installed: unknown = {}) => {
  const values = new Map<string, unknown>([["codeAcp.installedAgents", installed]]);
  return {
    globalStorageUri: { fsPath: storage },
    globalState: {
      get: (key: string) => values.get(key),
      update: async (key: string, value: unknown) => void values.set(key, value),
    },
  } as unknown as vscode.ExtensionContext;
};

/** Runs `body` with storage under a temp dir and a sibling `victim` file the installer must never touch. */
const withManager = <A, E>(
  body: (paths: {
    readonly root: string;
    readonly victim: string;
    readonly requests: { count: number };
  }) => Effect.Effect<A, E, AgentManager>,
  installed?: unknown,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const base = yield* fs.makeTempDirectoryScoped();
    const storage = path.join(base, "storage");
    const root = path.join(storage, "agents");
    const victim = path.join(base, "victim");
    yield* fs.makeDirectory(root, { recursive: true });
    yield* fs.writeFileString(victim, "keep");
    const requests = { count: 0 };
    const http = HttpClient.make((request) => {
      requests.count++;
      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(CONTENT)));
    });
    const layer = AgentManager.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          NodeChildProcessSpawner.layer.pipe(Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))),
          Layer.succeed(HttpClient.HttpClient, http),
          Layer.succeed(Output, makeOutput()),
          Layer.succeed(ExtensionCtx, makeContext(storage, installed)),
        ),
      ),
    );
    return yield* body({ root, victim, requests }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)), Effect.scoped);

const install = (agent: RegistryAgent) => AgentManager.use((manager) => manager.install(agent, () => Effect.void));

const exists = (file: string) =>
  Effect.gen(function* () {
    return yield* (yield* FileSystem.FileSystem).exists(file);
  }).pipe(Effect.provide(NodeFileSystem.layer), Effect.orDie);

describe("isPathSegment", () => {
  it("accepts the ids and versions the registry uses", () => {
    for (const name of ["claude-acp", "0.5.0", "1.0.73+180523.e6179a031de9", "1.0.0-beta_1"]) {
      assert.isTrue(isPathSegment(name), name);
    }
  });

  it("rejects anything that is not a plain directory name", () => {
    for (const name of ["", ".", "..", "../x", "a/b", "a\\b", "a/..", "/abs", "C:x", ".hidden", "-x", "a b"]) {
      assert.isFalse(isPathSegment(name), name);
    }
  });
});

describe("AgentManager.install", () => {
  it.live("installs a binary inside its version directory", () =>
    withManager(({ root }) =>
      Effect.gen(function* () {
        const installed = yield* install(binaryAgent({}));
        assert.isTrue(installed.command.startsWith(root));
        assert.isTrue(yield* exists(installed.command));
        assert.deepStrictEqual(warnings, []);
      }),
    ),
  );

  for (const agent of [
    { id: "../../victim" },
    { id: "." },
    { id: "a/.." },
    { version: ".." },
    { version: "../../.." },
  ]) {
    it.live(`rejects ${JSON.stringify(agent)} before touching the disk`, () =>
      withManager(({ victim, root, requests }) =>
        Effect.gen(function* () {
          yield* FileSystem.FileSystem.use((fs) => fs.writeFileString(`${root}/other`, "keep")).pipe(
            Effect.provide(NodeFileSystem.layer),
            Effect.orDie,
          );
          const error = yield* Effect.flip(install(binaryAgent({}, agent)));
          assert.include(error.message, "unsafe");
          assert.isTrue(yield* exists(victim));
          assert.isTrue(yield* exists(`${root}/other`));
          assert.strictEqual(requests.count, 0);
        }),
      ),
    );
  }

  for (const cmd of ["../../victim", "../tool", "/tmp/code-acp-evil", ".", "./"]) {
    it.live(`rejects cmd ${cmd} and keeps the copy already installed`, () =>
      withManager(({ root, victim, requests }) =>
        Effect.gen(function* () {
          const current = yield* install(binaryAgent({}));
          requests.count = 0;
          const error = yield* Effect.flip(install(binaryAgent({ cmd })));
          assert.include(error.message, "unsafe");
          assert.isTrue(yield* exists(current.command));
          assert.isTrue(yield* exists(victim));
          assert.isTrue(current.command.startsWith(root));
          assert.strictEqual(requests.count, 0);
        }),
      ),
    );
  }

  it.live("warns when the registry has no checksum, and still installs", () =>
    withManager(() =>
      Effect.gen(function* () {
        const installed = yield* install(binaryAgent({ sha256: undefined }));
        assert.isTrue(yield* exists(installed.command));
        assert.strictEqual(warnings.length, 1);
        assert.include(warnings[0], "tool");
      }),
    ),
  );

  for (const sha256 of ["0".repeat(64), ""]) {
    it.live(`fails on the checksum ${JSON.stringify(sha256)}`, () =>
      withManager(() =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(install(binaryAgent({ sha256 })));
          assert.include(error.message, "checksum");
          assert.deepStrictEqual(warnings, []);
        }),
      ),
    );
  }

  it.live("does not follow an unsafe previous version when updating", () => {
    const previous = {
      id: "tool",
      name: "Tool",
      version: "../../../victim",
      kind: "binary",
      command: "x",
      args: [],
      env: {},
    };
    return withManager(
      ({ victim }) =>
        Effect.gen(function* () {
          yield* install(binaryAgent({}));
          assert.isTrue(yield* exists(victim));
        }),
      { tool: previous },
    );
  });
});

describe("AgentManager.uninstall", () => {
  it.live("removes the agent's directory", () =>
    withManager(() =>
      Effect.gen(function* () {
        const installed = yield* install(binaryAgent({}));
        yield* AgentManager.use((manager) => manager.uninstall("tool"));
        assert.isFalse(yield* exists(installed.command));
        assert.isUndefined(yield* AgentManager.use((manager) => manager.get("tool")));
      }),
    ),
  );

  for (const id of ["..", ".", "../../victim"]) {
    it.live(`clears a stored id ${id} without deleting outside its directory`, () => {
      const stored = { id, name: "Bad", version: "1.0.0", kind: "binary", command: "x", args: [], env: {} };
      return withManager(
        ({ root, victim }) =>
          Effect.gen(function* () {
            yield* AgentManager.use((manager) => manager.uninstall(id));
            assert.isTrue(yield* exists(root));
            assert.isTrue(yield* exists(victim));
            assert.isUndefined(yield* AgentManager.use((manager) => manager.get(id)));
          }),
        { [id]: stored },
      );
    });
  }
});
