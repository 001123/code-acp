import { Option, Schema } from "effect";
import * as vscode from "vscode";
import { LOWEST_EFFORT } from "./sessionOptions";

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

/** A model starred for an agent, with its name for when that agent is not running. */
export const FavoriteModel = Schema.Struct({ value: Schema.String, name: Schema.String });
export type FavoriteModel = typeof FavoriteModel.Type;

/** One entry of codeAcp.providers: how an agent (installed or custom) runs and what its model picker shows; what is left out keeps the defaults. */
export const ProviderPrefs = Schema.Struct({
  /** False hides the agent from the chat and keeps it from being the default. */
  enabled: Schema.optional(Schema.Boolean),
  /** Arguments added after the agent's own on every start. */
  args: Schema.optional(Schema.Array(Schema.String)),
  /** Variables set for this agent alone, over codeAcp.env. */
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  /** Model values left out of the chat's model picker. */
  hiddenModels: Schema.optional(Schema.Array(Schema.String)),
  /** Model values in the order the picker lists them; those left out follow in the agent's order. */
  modelOrder: Schema.optional(Schema.Array(Schema.String)),
  favorites: Schema.optional(Schema.Array(FavoriteModel)),
});
export type ProviderPrefs = typeof ProviderPrefs.Type;

const ApprovalRule = Schema.optional(Schema.Literals(["ask", "allow"]));

/** Which permission requests are answered without asking; what is left out is asked about, or follows the user's rules in a workspace. */
export const ApprovalRules = Schema.Struct({
  /** Reads and searches inside the tab's folder. */
  read: ApprovalRule,
  /** Edits and moves inside the tab's folder, except in folders whose files can run something. */
  edit: ApprovalRule,
  execute: ApprovalRule,
  fetch: ApprovalRule,
  /** Everything that says what it does, in tabs with a worktree of their own. */
  worktreeTabs: ApprovalRule,
});
export type ApprovalRules = typeof ApprovalRules.Type;

const FastModeSetting = Schema.Literals(["default", "on", "off"]);

/** One entry of codeAcp.sessionDefaults: what new sessions of an agent start with; what is left out stays open. */
export const SessionDefaults = Schema.Struct({
  model: Schema.optional(Schema.String),
  effort: Schema.optional(Schema.String),
  fastMode: Schema.optional(FastModeSetting),
});
export type SessionDefaults = typeof SessionDefaults.Type;

/** Schemas of the codeAcp.* settings; keep in sync with `contributes.configuration` in package.json. */
export const Settings = Schema.Struct({
  language: Schema.Literals(["auto", "en", "vi"]),
  /** Agents run from local commands, by name; listed next to the installed ones. */
  customAgents: Schema.Record(Schema.String, CustomAgentEntry),
  env: Schema.Record(Schema.String, Schema.String),
  /** How each agent runs and what its model picker shows, by agent id. */
  providers: Schema.Record(Schema.String, ProviderPrefs),
  nodePath: Schema.String,
  /** Path of the ccusage executable for the Usage tab; empty runs a pinned release through `npx -y`. */
  ccusagePath: Schema.String,
  /** Look for agent updates in the ACP Registry on startup and offer to install them. */
  checkAgentUpdates: Schema.Boolean,
  /** Open the files the agent reads and edits in the editor, at the line it is on. */
  followAgent: Schema.Boolean,
  /** Keep the chat scrolled to the end as new content arrives. */
  autoScroll: Schema.Boolean,
  /** Show the bar above the composer with the files the agent changed, to keep or undo them. */
  showChanges: Schema.Boolean,
  /** Show the Restore button on the user's messages. */
  showRestore: Schema.Boolean,
  /** Show each turn's numbers in the chat and log the messages exchanged with agents, for advanced users. */
  tracing: Schema.Boolean,
  /** Show a notification when a tab the user isn't looking at finishes or asks for permission. */
  notifications: Schema.Boolean,
  /** Among those notifications, also show the one for a tab that finished. */
  notifyFinished: Schema.Boolean,
  /** The model, effort and fast mode to start sessions with, by agent id. */
  sessionDefaults: Schema.Record(Schema.String, SessionDefaults),
  /** Run each new chat tab in a git worktree of its own, on a new branch. */
  worktreeForNewTabs: Schema.Boolean,
  /** Ignored files to copy from the base checkout into a new worktree, as gitignore patterns. */
  worktreeCopyFiles: Schema.Array(Schema.String),
  /** Shell command to run at the top of a new worktree; user settings only, as a repository must not choose it. */
  worktreeSetupCommand: Schema.String,
  /** A project's own setup command; read by `projectSetupCommand`, and only run once the user allows it. */
  worktreeProjectSetupCommand: Schema.String,
  /** Installed agent id for commit messages; empty means the default agent. */
  "commitMessage.agent": Schema.String,
  /** Model value (or name) to pick in the commit session; empty keeps the agent's default. */
  "commitMessage.model": Schema.String,
  "commitMessage.instructions": Schema.String,
  /** Level of thinking to pick in the commit session; empty keeps the agent's default, "lowest" the least. */
  "commitMessage.effort": Schema.String,
  /** Turn the agent's fast mode on or off in the commit session; "default" leaves it as it is. */
  "commitMessage.fastMode": FastModeSetting,
  /** Extra MCP servers for every session, by name. */
  mcpServers: Schema.Record(Schema.String, McpServerEntry),
  /** Hosts besides this machine that links from agents may reach over plain http. */
  allowedHttpHosts: Schema.Array(Schema.String),
  /** The user's rules for answering permission requests without asking; a workspace's are kept by `AutoApprove`. */
  autoApprove: ApprovalRules,
});
export type Settings = typeof Settings.Type;
export type SettingKey = keyof Settings;

export const SETTING_KEYS = [
  "language",
  "customAgents",
  "env",
  "providers",
  "nodePath",
  "ccusagePath",
  "checkAgentUpdates",
  "followAgent",
  "autoScroll",
  "showChanges",
  "showRestore",
  "tracing",
  "notifications",
  "notifyFinished",
  "sessionDefaults",
  "worktreeForNewTabs",
  "worktreeCopyFiles",
  "worktreeSetupCommand",
  "worktreeProjectSetupCommand",
  "commitMessage.agent",
  "commitMessage.model",
  "commitMessage.instructions",
  "commitMessage.effort",
  "commitMessage.fastMode",
  "mcpServers",
  "allowedHttpHosts",
  "autoApprove",
] as const satisfies ReadonlyArray<SettingKey>;

/** Default of codeAcp.commitMessage.instructions; keep in sync with package.json. */
export const DEFAULT_COMMIT_INSTRUCTIONS =
  "Use Conventional Commits: type(scope): subject, where type is feat, fix, docs, style, refactor, perf, test, build, ci or chore and the scope is optional. Write a single subject line only, no body.";

const DEFAULTS: Settings = {
  language: "auto",
  customAgents: {},
  env: {},
  providers: {},
  nodePath: "node",
  ccusagePath: "",
  checkAgentUpdates: true,
  followAgent: false,
  autoScroll: true,
  showChanges: true,
  showRestore: false,
  tracing: false,
  notifications: true,
  notifyFinished: true,
  sessionDefaults: {},
  worktreeForNewTabs: false,
  worktreeCopyFiles: [],
  worktreeSetupCommand: "",
  worktreeProjectSetupCommand: "",
  "commitMessage.agent": "",
  "commitMessage.model": "",
  "commitMessage.instructions": DEFAULT_COMMIT_INSTRUCTIONS,
  // A commit message wants a quick answer more than a long thought.
  "commitMessage.effort": LOWEST_EFFORT,
  "commitMessage.fastMode": "default",
  mcpServers: {},
  allowedHttpHosts: [],
  autoApprove: {},
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
    providers: read("providers"),
    nodePath: read("nodePath"),
    ccusagePath: read("ccusagePath"),
    checkAgentUpdates: read("checkAgentUpdates"),
    followAgent: read("followAgent"),
    autoScroll: read("autoScroll"),
    showChanges: read("showChanges"),
    showRestore: read("showRestore"),
    tracing: read("tracing"),
    notifications: read("notifications"),
    notifyFinished: read("notifyFinished"),
    sessionDefaults: read("sessionDefaults"),
    worktreeForNewTabs: read("worktreeForNewTabs"),
    worktreeCopyFiles: read("worktreeCopyFiles"),
    worktreeSetupCommand: read("worktreeSetupCommand"),
    worktreeProjectSetupCommand: read("worktreeProjectSetupCommand"),
    "commitMessage.agent": read("commitMessage.agent"),
    "commitMessage.model": read("commitMessage.model"),
    "commitMessage.instructions": read("commitMessage.instructions"),
    "commitMessage.effort": read("commitMessage.effort"),
    "commitMessage.fastMode": read("commitMessage.fastMode"),
    mcpServers: read("mcpServers"),
    allowedHttpHosts: read("allowedHttpHosts"),
    autoApprove: read("autoApprove"),
  };
}

/** Where the Settings page reads and writes: the user's settings, or those of the open workspace. */
export type SettingsScope = "user" | "workspace";

/** Settings with `"scope": "machine"` in package.json: they decide what runs, so a workspace can't set them. */
export const USER_ONLY_SETTINGS: ReadonlyArray<SettingKey> = [
  "customAgents",
  "env",
  "providers",
  "nodePath",
  "ccusagePath",
  "worktreeSetupCommand",
  "mcpServers",
  "allowedHttpHosts",
  "autoApprove",
];

/** Settings that mean something only for a project. */
export const WORKSPACE_ONLY_SETTINGS: ReadonlyArray<SettingKey> = ["worktreeProjectSetupCommand"];

/** The settings that can't be changed in `scope`. */
export const lockedSettings = (scope: SettingsScope): ReadonlyArray<SettingKey> =>
  scope === "user" ? WORKSPACE_ONLY_SETTINGS : USER_ONLY_SETTINGS;

/** The setup command the project of `folder` asks for, from its folder or workspace settings; a user value doesn't count. */
export function projectSetupCommand(folder: string): string {
  const info = vscode.workspace
    .getConfiguration("codeAcp", vscode.Uri.file(folder))
    .inspect("worktreeProjectSetupCommand");
  const command = Schema.decodeUnknownOption(Schema.String)(info?.workspaceFolderValue ?? info?.workspaceValue);
  return Option.getOrElse(command, () => "").trim();
}

/** Whether `value` is a valid value for setting `key` (for values coming from a webview). */
export function isValidSetting(key: SettingKey, value: unknown): boolean {
  return Option.isSome(decodeSettings({ ...DEFAULTS, [key]: value }));
}
