import { Context, Effect, FileSystem, Layer, Option, Path, Schedule, Schema } from "effect";
import { HttpClient } from "effect/http";
import { t } from "./i18n";
import { ExtensionCtx, messageOf } from "./runtime";

export const REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

const StringArray = Schema.Array(Schema.String);
const Env = Schema.Record(Schema.String, Schema.String);

export const PackageDistribution = Schema.Struct({
  package: Schema.String,
  args: Schema.optional(StringArray),
  env: Schema.optional(Env),
});
export type PackageDistribution = typeof PackageDistribution.Type;

export const BinaryTarget = Schema.Struct({
  archive: Schema.String,
  cmd: Schema.String,
  sha256: Schema.optional(Schema.String),
  args: Schema.optional(StringArray),
  env: Schema.optional(Env),
});
export type BinaryTarget = typeof BinaryTarget.Type;

export const Platform = Schema.Literals([
  "darwin-aarch64",
  "darwin-x86_64",
  "linux-aarch64",
  "linux-x86_64",
  "windows-aarch64",
  "windows-x86_64",
]);
export type Platform = typeof Platform.Type;

export const Distribution = Schema.Struct({
  npx: Schema.optional(PackageDistribution),
  uvx: Schema.optional(PackageDistribution),
  // Keyed by Platform; a string key keeps platforms added to the registry later from failing decoding.
  binary: Schema.optional(Schema.Record(Schema.String, BinaryTarget)),
});
export type Distribution = typeof Distribution.Type;

export const RegistryAgent = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  version: Schema.String,
  description: Schema.String,
  repository: Schema.optional(Schema.String),
  website: Schema.optional(Schema.String),
  authors: Schema.optional(StringArray),
  license: Schema.optional(Schema.String),
  license_url: Schema.optional(Schema.String),
  icon: Schema.optional(Schema.String),
  distribution: Distribution,
});
export type RegistryAgent = typeof RegistryAgent.Type;

export const Registry = Schema.Struct({
  version: Schema.String,
  agents: Schema.Array(RegistryAgent),
});
export type Registry = typeof Registry.Type;

const decodeRegistry = Schema.decodeUnknownEffect(Schema.fromJsonString(Registry));

export function currentPlatform(): Platform | undefined {
  const os = { darwin: "darwin", linux: "linux", win32: "windows" }[process.platform as string];
  const arch = { arm64: "aarch64", x64: "x86_64" }[process.arch as string];
  return Option.getOrUndefined(Schema.decodeUnknownOption(Platform)(`${os}-${arch}`));
}

/** The binary build of `agent` for this machine, if the registry ships one. */
export function binaryTarget(agent: RegistryAgent): BinaryTarget | undefined {
  const platform = currentPlatform();
  return platform ? agent.distribution.binary?.[platform] : undefined;
}

export class RegistryError extends Schema.TaggedError<RegistryError>()("RegistryError", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

/** The ACP Registry, with the last downloaded copy as an offline fallback. */
export class AcpRegistry extends Context.Service<AcpRegistry, {
  readonly fetch: Effect.Effect<Registry, RegistryError>;
}>()("code-acp/AcpRegistry") {
  static readonly layer = Layer.effect(
    AcpRegistry,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const storage = (yield* ExtensionCtx).globalStorageUri.fsPath;
      const cache = path.join(storage, "registry.json");
      const client = (yield* HttpClient.HttpClient).pipe(
        HttpClient.filterStatusOk,
        HttpClient.retryTransient({ schedule: Schedule.exponential("200 millis"), times: 2 }),
      );

      const download = Effect.gen(function* () {
        const text = yield* client.get(REGISTRY_URL).pipe(
          Effect.flatMap((res) => res.text),
          Effect.timeout("30 seconds"),
        );
        const registry = yield* decodeRegistry(text).pipe(
          Effect.mapError((cause) => new RegistryError({ message: t("registry.invalid"), cause })),
        );
        // A cache that cannot be written only costs the offline fallback.
        yield* fs.makeDirectory(storage, { recursive: true }).pipe(
          Effect.andThen(fs.writeFileString(cache, text)),
          Effect.catch((err) => Effect.logWarning(`[registry] cache not written: ${err.message}`)),
        );
        return registry;
      });

      const fetch = download.pipe(
        Effect.catch((err) =>
          fs.readFileString(cache).pipe(
            Effect.flatMap(decodeRegistry),
            Effect.tap(() => Effect.logWarning(`[registry] offline, using cache: ${messageOf(err)}`)),
            Effect.mapError(() => new RegistryError({ message: t("registry.fetchFailed", messageOf(err)), cause: err })),
          ),
        ),
        Effect.withSpan("AcpRegistry.fetch"),
      );

      return AcpRegistry.of({ fetch });
    }),
  );
}
