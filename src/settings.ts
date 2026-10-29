import { Option, Schema } from "effect";
import * as vscode from "vscode";

/** One entry of codeAcp.mcpServers, in the `.mcp.json` shape: stdio when `url` is absent. */
export const McpServerEntry = Schema.Union([
  Schema.Struct({
    type: Schema.optional(Schema.Literal("stdio")),
    command: Schema.String,
    args: Schema.optional(Schema.Array(Schema.String)),
    env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  }),
  Schema.Struct({
    type: Schema.Literals(["http", "sse"]),
    url: Schema.String,
    headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  }),
]);
export type McpServerEntry = typeof McpServerEntry.Type;

/** One entry of codeAcp.customAgents: an ACP agent run from a local command. */
export const CustomAgentEntry = Schema.Struct({
  command: Schema.String,
  args: Schema.optional(Schema.Array(Schema.String)),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
export type CustomAgentEntry = typeof CustomAgentEntry.Type;

/** Schemas of the codeAcp.* settings; keep in sync with `contributes.configuration` in package.json. */
export const Settings = Schema.Struct({
  language: Schema.Literals(["auto", "en", "vi"]),
  /** Agents run from local commands, by name; listed next to the installed ones. */
  customAgents: Schema.Record(Schema.String, CustomAgentEntry),
  env: Schema.Record(Schema.String, Schema.String),
  nodePath: Schema.String,
  /** Look for agent updates in the ACP Registry once a day and offer to install them. */
  checkAgentUpdates: Schema.Boolean,
  /** Open the files the agent reads and edits in the editor, at the line it is on. */
  followAgent: Schema.Boolean,
  /** Keep the chat scrolled to the end as new content arrives. */
  autoScroll: Schema.Boolean,
  /** Installed agent id for commit messages; empty means the default agent. */
  "commitMessage.agent": Schema.String,
  /** Model value (or name) to pick in the commit session; empty keeps the agent's default. */
  "commitMessage.model": Schema.String,
  "commitMessage.instructions": Schema.String,
  /** Extra MCP servers for every session, by name. */
  mcpServers: Schema.Record(Schema.String, McpServerEntry),
});
export type Settings = typeof Settings.Type;
export type SettingKey = keyof Settings;

export const SETTING_KEYS = [
  "language",
  "customAgents",
  "env",
  "nodePath",
  "checkAgentUpdates",
  "followAgent",
  "autoScroll",
  "commitMessage.agent",
  "commitMessage.model",
  "commitMessage.instructions",
  "mcpServers",
] as const satisfies ReadonlyArray<SettingKey>;

/** Default of codeAcp.commitMessage.instructions; keep in sync with package.json. */
export const DEFAULT_COMMIT_INSTRUCTIONS =
  "Use Conventional Commits: type(scope): subject, where type is feat, fix, docs, style, refactor, perf, test, build, ci or chore and the scope is optional. Write a single subject line only, no body.";

const DEFAULTS: Settings = {
  language: "auto",
  customAgents: {},
  env: {},
  nodePath: "node",
  checkAgentUpdates: true,
  followAgent: false,
  autoScroll: true,
  "commitMessage.agent": "",
  "commitMessage.model": "",
  "commitMessage.instructions": DEFAULT_COMMIT_INSTRUCTIONS,
  mcpServers: {},
};

const decodeSettings = Schema.decodeUnknownOption(Settings);

/** Current value of every codeAcp.* setting; an invalid value falls back to its default. */
export function readSettings(): Settings {
  const config = vscode.workspace.getConfiguration("codeAcp");
  const read = <K extends SettingKey>(key: K): Settings[K] => {
    const value = config.get(key);
    return Option.match(decodeSettings({ ...DEFAULTS, [key]: value }), {
      onNone: () => DEFAULTS[key],
      onSome: (settings) => settings[key],
    });
  };
  return {
    language: read("language"),
    customAgents: read("customAgents"),
    env: read("env"),
    nodePath: read("nodePath"),
    checkAgentUpdates: read("checkAgentUpdates"),
    followAgent: read("followAgent"),
    autoScroll: read("autoScroll"),
    "commitMessage.agent": read("commitMessage.agent"),
    "commitMessage.model": read("commitMessage.model"),
    "commitMessage.instructions": read("commitMessage.instructions"),
    mcpServers: read("mcpServers"),
  };
}

/** Whether `value` is a valid value for setting `key` (for values coming from a webview). */
export function isValidSetting(key: SettingKey, value: unknown): boolean {
  return Option.isSome(decodeSettings({ ...DEFAULTS, [key]: value }));
}
