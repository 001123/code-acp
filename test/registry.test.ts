import { NodeFileSystem, NodePath } from "@effect/platform-node-shared";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import {
  AcpRegistry,
  binaryTarget,
  currentPlatform,
  Registry,
  type RegistryAgent,
  REGISTRY_URL,
} from "../src/registry";
import { ExtensionCtx } from "../src/runtime";
import { makeExtensionCtx } from "./helpers";

const registryJson = {
  version: "1.0.0",
  agents: [
    {
      id: "claude-acp",
      name: "Claude Agent",
      version: "0.5.0",
      description: "ACP wrapper for Claude",
      repository: "https://github.com/x/claude-acp",
      authors: ["Someone"],
      license: "MIT",
      icon: "https://cdn/claude.svg",
      distribution: { npx: { package: "@x/claude-acp@0.5.0", args: ["--acp"], env: { A: "b" } } },
    },
    {
      id: "tool",
      name: "Tool",
      version: "2.0.0",
      description: "Binary agent",
      distribution: {
        uvx: { package: "tool-acp" },
        binary: {
          "darwin-aarch64": { archive: "https://a/darwin-arm.tgz", cmd: "./tool", sha256: "abc" },
          "darwin-x86_64": { archive: "https://a/darwin-x64.tgz", cmd: "./tool" },
          "linux-x86_64": { archive: "https://a/linux.tgz", cmd: "./tool", args: ["acp"] },
          "linux-aarch64": { archive: "https://a/linux-arm.tgz", cmd: "./tool" },
          "windows-x86_64": { archive: "https://a/win.zip", cmd: "tool.exe" },
          "windows-aarch64": { archive: "https://a/win-arm.zip", cmd: "tool.exe" },
          "freebsd-riscv64": { archive: "https://a/bsd.tgz", cmd: "./tool" },
        },
      },
    },
  ],
};

const decode = Schema.decodeUnknownSync(Registry);

describe("Registry schema", () => {
  it("decodes a realistic registry, keeping unknown platforms", () => {
    const registry = decode(registryJson);
    assert.strictEqual(registry.agents.length, 2);
    assert.strictEqual(registry.agents[0]!.distribution.npx?.package, "@x/claude-acp@0.5.0");
    assert.deepStrictEqual(registry.agents[0]!.distribution.npx?.env, { A: "b" });
    const binary = registry.agents[1]!.distribution.binary!;
    assert.isDefined(binary["freebsd-riscv64"]);
    assert.strictEqual(binary["linux-x86_64"]!.args?.[0], "acp");
  });

  it("rejects invalid data", () => {
    assert.throws(() => decode({ version: "1" }));
    assert.throws(() => decode({ version: "1", agents: [{ id: "x" }] }));
    assert.throws(() => decode({ ...registryJson, agents: [{ ...registryJson.agents[0], distribution: undefined }] }));
    assert.throws(() =>
      decode({
        version: "1",
        agents: [{ ...registryJson.agents[0], distribution: { binary: { "linux-x86_64": { cmd: "x" } } } }],
      }),
    );
    assert.throws(() => decode(null));
  });
});

describe("currentPlatform / binaryTarget", () => {
  const agent = decode(registryJson).agents[1]! as RegistryAgent;

  it("maps process.platform and arch to a registry platform", () => {
    const os = { darwin: "darwin", linux: "linux", win32: "windows" }[process.platform as string];
    const arch = { arm64: "aarch64", x64: "x86_64" }[process.arch as string];
    assert.strictEqual(currentPlatform(), os && arch ? `${os}-${arch}` : undefined);
  });

  it("selects the binary of this machine", () => {
    const platform = currentPlatform();
    const target = binaryTarget(agent);
    assert.strictEqual(target, platform ? agent.distribution.binary![platform] : undefined);
    assert.isDefined(target);
  });

  it("returns undefined without binary builds", () => {
    assert.isUndefined(binaryTarget(decode(registryJson).agents[0]!));
  });

  it("returns undefined when the platform has no build", () => {
    const only: RegistryAgent = { ...agent, distribution: { binary: { "freebsd-riscv64": { archive: "a", cmd: "c" } } } };
    assert.isUndefined(binaryTarget(only));
  });
});

describe("AcpRegistry", () => {
  const httpLayer = (respond: () => Response | Error) =>
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        const result = respond();
        return result instanceof Error
          ? Effect.die(result)
          : Effect.succeed(HttpClientResponse.fromWeb(request, result));
      }),
    );

  const withRegistry = <A, E>(
    respond: () => Response | Error,
    body: (storage: string, requests: { count: number }) => Effect.Effect<A, E, AcpRegistry | FileSystem.FileSystem | Path.Path>,
  ) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped();
      const storage = path.join(dir, "storage");
      const requests = { count: 0 };
      const layer = AcpRegistry.layer.pipe(
        Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
        Layer.provide(
          httpLayer(() => {
            requests.count++;
            return respond();
          }),
        ),
        Layer.provide(Layer.succeed(ExtensionCtx, makeExtensionCtx(storage))),
      );
      return yield* body(storage, requests).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)), Effect.scoped);

  const json = JSON.stringify(registryJson);

  it.live("downloads, decodes and caches the registry", () =>
    withRegistry(
      () => new Response(json, { status: 200 }),
      (storage) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const registry = yield* (yield* AcpRegistry).fetch;
          assert.strictEqual(registry.agents.length, 2);
          assert.strictEqual(yield* fs.readFileString(`${storage}/registry.json`), json);
        }),
    ),
  );

  it.live("requests the registry URL", () =>
    Effect.gen(function* () {
      let url = "";
      const layer = AcpRegistry.layer.pipe(
        Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
        Layer.provide(
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) => {
              url = request.url;
              return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(json)));
            }),
          ),
        ),
        Layer.provide(Layer.succeed(ExtensionCtx, makeExtensionCtx("/tmp/code-acp-test-url"))),
      );
      yield* AcpRegistry.use((r) => r.fetch).pipe(Effect.provide(layer));
      assert.strictEqual(url, REGISTRY_URL);
    }),
  );

  it.live("falls back to the cached copy when the download fails", () =>
    withRegistry(
      () => new Response("nope", { status: 404 }),
      (storage, requests) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* fs.makeDirectory(storage, { recursive: true });
          yield* fs.writeFileString(`${storage}/registry.json`, json);
          const registry = yield* (yield* AcpRegistry).fetch;
          assert.strictEqual(registry.agents[0]!.id, "claude-acp");
          assert.isAtLeast(requests.count, 1);
        }),
    ),
  );

  it.live("fails with RegistryError when offline and nothing is cached", () =>
    withRegistry(
      () => new Response("nope", { status: 404 }),
      () =>
        Effect.gen(function* () {
          const error = yield* Effect.flip((yield* AcpRegistry).fetch);
          assert.strictEqual(error._tag, "RegistryError");
          assert.isAbove(error.message.length, 0);
        }),
    ),
  );

  it.live("rejects an invalid download and uses the cache instead", () =>
    withRegistry(
      () => new Response("{\"version\":1}", { status: 200 }),
      (storage) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* fs.makeDirectory(storage, { recursive: true });
          yield* fs.writeFileString(`${storage}/registry.json`, json);
          const registry = yield* (yield* AcpRegistry).fetch;
          assert.strictEqual(registry.agents.length, 2);
          // The invalid body must not overwrite the cache.
          assert.strictEqual(yield* fs.readFileString(`${storage}/registry.json`), json);
        }),
    ),
  );

  it.live("fails when the download is invalid and nothing is cached", () =>
    withRegistry(
      () => new Response("not json", { status: 200 }),
      () =>
        Effect.gen(function* () {
          const error = yield* Effect.flip((yield* AcpRegistry).fetch);
          assert.strictEqual(error._tag, "RegistryError");
        }),
    ),
  );
});
