import { assert, beforeEach, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { AgentCatalog, type CatalogState } from "../src/agentCatalog";
import type { AgentManager } from "../src/agentManager";
import { AcpRegistry, RegistryError, type Registry } from "../src/registry";
import { __test } from "./stubs/vscode";

beforeEach(() => __test.reset());

const npx = { npx: { package: "tool" } };
const registry: Registry = {
  version: "1",
  agents: [
    { id: "one", name: "One", version: "2.0.0", description: "first", distribution: npx },
    {
      id: "two",
      name: "Two",
      version: "1.0.0",
      description: "second",
      distribution: npx,
      website: "https://two.example",
    },
  ],
} as unknown as Registry;

const makeManager = (install: AgentManager["Service"]["install"] = () => Effect.void as never) =>
  ({
    activeId: Effect.succeed("one"),
    list: Effect.succeed([{ id: "one", version: "1.0.0" }]),
    install,
  }) as unknown as AgentManager["Service"];

/** A catalog, what it posted, and how often the registry was fetched; the fetches fail while `failing.now`. */
const setup = (manager = makeManager()) => {
  const posted: CatalogState[] = [];
  const fetches = { count: 0 };
  const failing = { now: false };
  const catalog = new AgentCatalog(manager, (state) => void posted.push(state));
  const fetch = Effect.suspend(() => {
    fetches.count++;
    return failing.now
      ? Effect.fail(new RegistryError({ message: "offline", cause: "test" }))
      : Effect.succeed(registry);
  });
  const layer = Layer.succeed(AcpRegistry, AcpRegistry.of({ fetch }));
  return { catalog, posted, fetches, failing, layer };
};

describe("AgentCatalog", () => {
  it.effect("fetches the registry once and marks what is installed and in use", () => {
    const { catalog, posted, fetches, layer } = setup();
    return Effect.gen(function* () {
      yield* catalog.onMessage({ type: "catalogLoad" });
      yield* catalog.onMessage({ type: "catalogLoad" });
      assert.strictEqual(fetches.count, 1);
      const last = posted.at(-1)!;
      assert.isFalse(last.loading);
      const one = last.agents.find((a) => a.id === "one")!;
      assert.strictEqual(one.installedVersion, "1.0.0");
      assert.isTrue(one.active);
      const two = last.agents.find((a) => a.id === "two")!;
      assert.isUndefined(two.installedVersion);
      assert.strictEqual(two.url, "https://two.example");
      assert.strictEqual(two.kind, "npx");
    }).pipe(Effect.provide(layer));
  });

  it.effect("shows a failed fetch and tries again on the next load", () => {
    const { catalog, posted, fetches, failing, layer } = setup();
    return Effect.gen(function* () {
      failing.now = true;
      yield* catalog.onMessage({ type: "catalogLoad" });
      assert.strictEqual(posted.at(-1)!.error, "offline");
      assert.isFalse(posted.at(-1)!.loading);
      failing.now = false;
      yield* catalog.onMessage({ type: "catalogLoad" });
      assert.strictEqual(fetches.count, 2);
      assert.isUndefined(posted.at(-1)!.error);
      assert.strictEqual(posted.at(-1)!.agents.length, 2);
    }).pipe(Effect.provide(layer));
  });

  it.effect("shows an install as busy until it ends, also when it fails", () => {
    const { catalog, posted, layer } = setup(makeManager(() => Effect.fail({ message: "no disk" }) as never));
    return Effect.gen(function* () {
      yield* catalog.onMessage({ type: "catalogRefresh" });
      yield* catalog.onMessage({ type: "catalogInstall", id: "two" });
      const busy = posted.map((state) => state.agents.find((a) => a.id === "two")?.busy);
      assert.isTrue(busy.some((message) => message !== undefined));
      assert.isUndefined(busy.at(-1));
    }).pipe(Effect.provide(layer));
  });

  it.effect("ignores an install of an agent the registry doesn't list", () => {
    let installs = 0;
    const { catalog, layer } = setup(
      makeManager(
        () =>
          Effect.sync(() => {
            installs++;
          }) as never,
      ),
    );
    return Effect.gen(function* () {
      yield* catalog.onMessage({ type: "catalogRefresh" });
      yield* catalog.onMessage({ type: "catalogInstall", id: "ghost" });
      assert.strictEqual(installs, 0);
    }).pipe(Effect.provide(layer));
  });
});
