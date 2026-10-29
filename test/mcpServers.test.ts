import { assert, describe, it, beforeEach } from "@effect/vitest";
import { Effect } from "effect";
import { __test } from "./stubs/vscode";
import { mcpServersFor } from "../src/mcpServers";

beforeEach(() => __test.reset());

describe("mcpServersFor", () => {
  it.effect("returns nothing when unset", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* mcpServersFor(undefined), []);
    }),
  );

  it.effect("converts stdio servers, with and without a type", () =>
    Effect.gen(function* () {
      __test.setSetting("codeAcp.mcpServers", {
        a: { command: "node", args: ["s.js"], env: { K: "v" } },
        b: { type: "stdio", command: "bin" },
      });
      assert.deepStrictEqual(yield* mcpServersFor(undefined), [
        { name: "a", command: "node", args: ["s.js"], env: [{ name: "K", value: "v" }] },
        { name: "b", command: "bin", args: [], env: [] },
      ]);
    }),
  );

  it.effect("converts http and sse servers when the agent supports them", () =>
    Effect.gen(function* () {
      __test.setSetting("codeAcp.mcpServers", {
        h: { type: "http", url: "https://h", headers: { Authorization: "x" } },
        s: { type: "sse", url: "https://s" },
      });
      assert.deepStrictEqual(yield* mcpServersFor({ http: true, sse: true }), [
        { type: "http", name: "h", url: "https://h", headers: [{ name: "Authorization", value: "x" }] },
        { type: "sse", name: "s", url: "https://s", headers: [] },
      ]);
    }),
  );

  it.effect("drops http/sse when the capability is missing", () =>
    Effect.gen(function* () {
      __test.setSetting("codeAcp.mcpServers", {
        h: { type: "http", url: "https://h" },
        s: { type: "sse", url: "https://s" },
        c: { command: "x" },
      });
      assert.deepStrictEqual((yield* mcpServersFor(undefined)).map((s) => s.name), ["c"]);
      assert.deepStrictEqual((yield* mcpServersFor({ http: true })).map((s) => s.name), ["h", "c"]);
      assert.deepStrictEqual((yield* mcpServersFor({ sse: true })).map((s) => s.name), ["s", "c"]);
    }),
  );

  it.effect("skips invalid entries but keeps the valid ones", () =>
    Effect.gen(function* () {
      __test.setSetting("codeAcp.mcpServers", {
        bad1: { type: "http" },
        bad2: "nope",
        bad3: { command: 1 },
        good: { command: "ok" },
      });
      assert.deepStrictEqual((yield* mcpServersFor({ http: true })).map((s) => s.name), ["good"]);
    }),
  );

  it.effect("returns nothing when the setting is not an object", () =>
    Effect.gen(function* () {
      __test.setSetting("codeAcp.mcpServers", ["x"]);
      assert.deepStrictEqual(yield* mcpServersFor(undefined), []);
      __test.setSetting("codeAcp.mcpServers", "x");
      assert.deepStrictEqual(yield* mcpServersFor(undefined), []);
    }),
  );
});
