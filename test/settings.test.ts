import { assert, describe, it, beforeEach } from "@effect/vitest";
import { Schema } from "effect";
import { __test } from "./stubs/vscode";
import { CustomAgentEntry, DEFAULT_COMMIT_INSTRUCTIONS, isValidSetting, McpServerEntry, readSettings, Settings } from "../src/settings";

beforeEach(() => __test.reset());

describe("readSettings", () => {
  it("returns defaults when nothing is configured", () => {
    const s = readSettings();
    assert.strictEqual(s.language, "auto");
    assert.deepStrictEqual(s.customAgents, {});
    assert.strictEqual(s.nodePath, "node");
    assert.isTrue(s.checkAgentUpdates);
    assert.isFalse(s.followAgent);
    assert.strictEqual(s["commitMessage.instructions"], DEFAULT_COMMIT_INSTRUCTIONS);
  });

  it("reads valid values", () => {
    __test.setSetting("codeAcp.language", "vi");
    __test.setSetting("codeAcp.followAgent", true);
    __test.setSetting("codeAcp.env", { A: "1" });
    __test.setSetting("codeAcp.customAgents", { mine: { command: "x", args: ["a"] } });
    const s = readSettings();
    assert.strictEqual(s.language, "vi");
    assert.isTrue(s.followAgent);
    assert.deepStrictEqual(s.env, { A: "1" });
    assert.deepStrictEqual(s.customAgents, { mine: { command: "x", args: ["a"] } });
  });

  it("falls back to the default of only the invalid setting", () => {
    __test.setSetting("codeAcp.language", "fr");
    __test.setSetting("codeAcp.followAgent", "yes");
    __test.setSetting("codeAcp.env", { A: 1 });
    __test.setSetting("codeAcp.nodePath", "/usr/bin/node");
    const s = readSettings();
    assert.strictEqual(s.language, "auto");
    assert.isFalse(s.followAgent);
    assert.deepStrictEqual(s.env, {});
    assert.strictEqual(s.nodePath, "/usr/bin/node");
  });

  it("falls back when a custom agent or MCP server entry is malformed", () => {
    __test.setSetting("codeAcp.customAgents", { bad: { args: [] } });
    __test.setSetting("codeAcp.mcpServers", { bad: { type: "http" } });
    const s = readSettings();
    assert.deepStrictEqual(s.customAgents, {});
    assert.deepStrictEqual(s.mcpServers, {});
  });
});

describe("isValidSetting", () => {
  it("accepts and rejects values per key", () => {
    assert.isTrue(isValidSetting("language", "en"));
    assert.isFalse(isValidSetting("language", "de"));
    assert.isTrue(isValidSetting("checkAgentUpdates", false));
    assert.isFalse(isValidSetting("checkAgentUpdates", "false"));
    assert.isFalse(isValidSetting("nodePath", null));
    assert.isTrue(isValidSetting("mcpServers", { s: { url: "u", type: "sse" } }));
    assert.isFalse(isValidSetting("mcpServers", { s: { url: "u" } }));
  });
});

describe("entry schemas", () => {
  const decodeAgent = Schema.decodeUnknownSync(CustomAgentEntry);
  const decodeMcp = Schema.decodeUnknownSync(McpServerEntry);

  it("CustomAgentEntry requires a command", () => {
    assert.deepStrictEqual(decodeAgent({ command: "a" }), { command: "a" });
    assert.deepStrictEqual(decodeAgent({ command: "a", args: ["b"], env: { K: "v" } }), {
      command: "a",
      args: ["b"],
      env: { K: "v" },
    });
    assert.throws(() => decodeAgent({ args: [] }));
    assert.throws(() => decodeAgent({ command: "a", args: [1] }));
  });

  it("McpServerEntry accepts stdio with or without type, http and sse", () => {
    assert.doesNotThrow(() => decodeMcp({ command: "c" }));
    assert.doesNotThrow(() => decodeMcp({ type: "stdio", command: "c", args: [] }));
    assert.doesNotThrow(() => decodeMcp({ type: "http", url: "u", headers: { a: "b" } }));
    assert.doesNotThrow(() => decodeMcp({ type: "sse", url: "u" }));
    assert.throws(() => decodeMcp({ type: "ws", url: "u" }));
    assert.throws(() => decodeMcp({ type: "http" }));
    assert.throws(() => decodeMcp({}));
  });

  it("Settings rejects a wrong language", () => {
    assert.throws(() => Schema.decodeUnknownSync(Settings)({}));
  });
});
