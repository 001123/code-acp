import { assert, describe, it, beforeEach } from "@effect/vitest";
import { Schema } from "effect";
import { readFileSync } from "node:fs";
import { __test } from "./stubs/vscode";
import { parseHosts } from "../src/ui/settings/hosts";
import {
  CustomAgentEntry,
  DEFAULT_COMMIT_INSTRUCTIONS,
  isValidSetting,
  lockedSettings,
  McpServerEntry,
  projectSetupCommand,
  readSettings,
  Settings,
  USER_ONLY_SETTINGS,
} from "../src/settings";
import { scopedSetting, valueToStore } from "../src/settingsPanel";

beforeEach(() => __test.reset());

describe("readSettings", () => {
  it("returns defaults when nothing is configured", () => {
    const s = readSettings();
    assert.strictEqual(s.language, "auto");
    assert.deepStrictEqual(s.customAgents, {});
    assert.strictEqual(s.nodePath, "node");
    assert.isTrue(s.checkAgentUpdates);
    assert.isFalse(s.followAgent);
    assert.isTrue(s.autoScroll);
    assert.isTrue(s.showChanges);
    assert.isFalse(s.showRestore);
    assert.isFalse(s.tracing);
    assert.isTrue(s.notifications);
    assert.isTrue(s.notifyFinished);
    assert.isTrue(s.rememberSessionOptions);
    assert.deepStrictEqual(s.sessionDefaults, {});
    assert.isFalse(s.worktreeForNewTabs);
    assert.deepStrictEqual(s.worktreeCopyFiles, []);
    assert.strictEqual(s.worktreeSetupCommand, "");
    assert.strictEqual(s.worktreeProjectSetupCommand, "");
    assert.deepStrictEqual(s.allowedHttpHosts, []);
    assert.strictEqual(s["commitMessage.instructions"], DEFAULT_COMMIT_INSTRUCTIONS);
  });

  it("reads session defaults by agent, and falls back on invalid ones", () => {
    __test.setSetting("codeAcp.sessionDefaults", { claude: { model: "opus", effort: "high", fastMode: "on" } });
    assert.deepStrictEqual(readSettings().sessionDefaults, { claude: { model: "opus", effort: "high", fastMode: "on" } });
    __test.setSetting("codeAcp.sessionDefaults", { claude: { fastMode: "maybe" } });
    assert.deepStrictEqual(readSettings().sessionDefaults, {});
  });

  it("reads valid values", () => {
    __test.setSetting("codeAcp.language", "vi");
    __test.setSetting("codeAcp.followAgent", true);
    __test.setSetting("codeAcp.autoScroll", false);
    __test.setSetting("codeAcp.showChanges", false);
    __test.setSetting("codeAcp.showRestore", true);
    __test.setSetting("codeAcp.notifyFinished", false);
    __test.setSetting("codeAcp.env", { A: "1" });
    __test.setSetting("codeAcp.customAgents", { mine: { command: "x", args: ["a"] } });
    const s = readSettings();
    assert.strictEqual(s.language, "vi");
    assert.isTrue(s.followAgent);
    assert.isFalse(s.autoScroll);
    assert.isFalse(s.showChanges);
    assert.isTrue(s.showRestore);
    assert.isFalse(s.notifyFinished);
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

describe("parseHosts", () => {
  it("keeps one normalized host per line, without blanks or repeats", () => {
    assert.deepStrictEqual(parseHosts(" GitLab.Internal \n\n192.168.1.10\r\ngitlab.internal\n[::1]\nmünchen.example"), [
      "gitlab.internal",
      "192.168.1.10",
      "[::1]",
      "xn--mnchen-3ya.example",
    ]);
    assert.deepStrictEqual(parseHosts(""), []);
  });

  it("gives the line of what is more than a host", () => {
    for (const bad of ["http://a", "a:8080", "a:80", "[::1]:8080", "a/b", "a/", "*.internal", "a?b", "a#b", "u@a", "a b", "::1"]) {
      assert.strictEqual(parseHosts(`ok\n${bad}`), 2, bad);
    }
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

describe("settings that decide what gets executed", () => {
  const properties: Record<string, { readonly scope?: string }> = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ).contributes.configuration.properties;

  for (const key of ["customAgents", "env", "nodePath", "ccusagePath", "mcpServers", "worktreeSetupCommand"]) {
    it(`codeAcp.${key} cannot be set by a workspace`, () => {
      assert.strictEqual(properties[`codeAcp.${key}`]?.scope, "machine");
    });
  }

  it("the Settings page locks exactly the settings a workspace can't set", () => {
    const machine = Object.entries(properties)
      .filter(([, property]) => property.scope === "machine")
      .map(([key]) => key.replace("codeAcp.", ""));
    assert.sameMembers([...USER_ONLY_SETTINGS], machine);
    assert.sameMembers([...lockedSettings("workspace")], machine);
  });

  it("a project's setup command can differ per folder of a workspace", () => {
    assert.strictEqual(properties["codeAcp.worktreeProjectSetupCommand"]?.scope, "resource");
  });
});

describe("projectSetupCommand", () => {
  const KEY = "codeAcp.worktreeProjectSetupCommand";

  it("comes from the folder's settings, then the workspace's, and never the user's", () => {
    __test.setSetting(KEY, "user");
    assert.strictEqual(projectSetupCommand("/repo"), "");
    __test.setWorkspaceSetting(KEY, " workspace ");
    assert.strictEqual(projectSetupCommand("/repo"), "workspace");
    __test.setFolderSetting("/repo", KEY, "folder");
    assert.strictEqual(projectSetupCommand("/repo"), "folder");
    assert.strictEqual(projectSetupCommand("/other"), "workspace");
  });

  it("ignores a value that is no text", () => {
    __test.setWorkspaceSetting(KEY, ["npm", "install"]);
    assert.strictEqual(projectSetupCommand("/repo"), "");
  });
});

describe("settings scopes", () => {
  it("shows the user's value and warns of a workspace one, in user scope", () => {
    assert.deepStrictEqual(scopedSetting("user", "autoScroll", { defaultValue: true }), { value: true, overridden: false });
    assert.deepStrictEqual(scopedSetting("user", "autoScroll", { defaultValue: true, globalValue: false, workspaceValue: true }), {
      value: false,
      overridden: true,
    });
  });

  it("shows the workspace's value, else what it inherits, in workspace scope", () => {
    assert.deepStrictEqual(scopedSetting("workspace", "autoScroll", { defaultValue: true, globalValue: false }), { value: false, overridden: false });
    assert.deepStrictEqual(scopedSetting("workspace", "autoScroll", { defaultValue: true, globalValue: false, workspaceValue: true }), {
      value: true,
      overridden: true,
    });
  });

  it("ignores a workspace value of a setting that can't have one", () => {
    assert.deepStrictEqual(scopedSetting("workspace", "nodePath", { globalValue: "/mine", workspaceValue: "/theirs" }), {
      value: "/mine",
      overridden: false,
    });
  });

  it("doesn't let a user value stand in for a project's setup command", () => {
    assert.deepStrictEqual(scopedSetting("workspace", "worktreeProjectSetupCommand", { defaultValue: "", globalValue: "x" }), {
      value: "",
      overridden: false,
    });
    assert.strictEqual(valueToStore("workspace", "worktreeProjectSetupCommand", "x", { defaultValue: "", globalValue: "x" }), "x");
  });

  it("doesn't warn in user scope of a project's setup command, which overrides nothing there", () => {
    assert.isFalse(scopedSetting("user", "worktreeProjectSetupCommand", { defaultValue: "", workspaceValue: "x" }).overridden);
  });

  it("removes a user value equal to the default", () => {
    assert.isUndefined(valueToStore("user", "autoScroll", true, { defaultValue: true }));
    assert.strictEqual(valueToStore("user", "autoScroll", false, { defaultValue: true }), false);
  });

  it("stores in a workspace what differs from what it inherits, even the default", () => {
    assert.strictEqual(valueToStore("workspace", "autoScroll", true, { defaultValue: true, globalValue: false }), true);
    assert.isUndefined(valueToStore("workspace", "autoScroll", false, { defaultValue: true, globalValue: false, workspaceValue: true }));
    assert.deepStrictEqual(valueToStore("workspace", "worktreeCopyFiles", [], { defaultValue: [], globalValue: [".env"] }), []);
    assert.isUndefined(valueToStore("workspace", "worktreeCopyFiles", [".env"], { defaultValue: [], globalValue: [".env"] }));
  });
});
