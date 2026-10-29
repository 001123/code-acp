import { Option, Schema } from "effect";
import * as vscode from "vscode";

/** Schemas of the codeAcp.* settings; keep in sync with `contributes.configuration` in package.json. */
export const Settings = Schema.Struct({
  language: Schema.Literals(["auto", "en", "vi"]),
  agentCommand: Schema.String,
  agentArgs: Schema.Array(Schema.String),
  env: Schema.Record(Schema.String, Schema.String),
  nodePath: Schema.String,
  /** Installed agent id for commit messages; empty means the default agent. */
  "commitMessage.agent": Schema.String,
  /** Model value (or name) to pick in the commit session; empty keeps the agent's default. */
  "commitMessage.model": Schema.String,
  "commitMessage.instructions": Schema.String,
});
export type Settings = typeof Settings.Type;
export type SettingKey = keyof Settings;

export const SETTING_KEYS = [
  "language",
  "agentCommand",
  "agentArgs",
  "env",
  "nodePath",
  "commitMessage.agent",
  "commitMessage.model",
  "commitMessage.instructions",
] as const satisfies ReadonlyArray<SettingKey>;

/** Default of codeAcp.commitMessage.instructions; keep in sync with package.json. */
export const DEFAULT_COMMIT_INSTRUCTIONS =
  "Use Conventional Commits: type(scope): subject, where type is feat, fix, docs, style, refactor, perf, test, build, ci or chore and the scope is optional. Keep it short: a subject line, plus a brief body only when the change needs explaining.";

const DEFAULTS: Settings = {
  language: "auto",
  agentCommand: "",
  agentArgs: [],
  env: {},
  nodePath: "node",
  "commitMessage.agent": "",
  "commitMessage.model": "",
  "commitMessage.instructions": DEFAULT_COMMIT_INSTRUCTIONS,
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
    agentCommand: read("agentCommand"),
    agentArgs: read("agentArgs"),
    env: read("env"),
    nodePath: read("nodePath"),
    "commitMessage.agent": read("commitMessage.agent"),
    "commitMessage.model": read("commitMessage.model"),
    "commitMessage.instructions": read("commitMessage.instructions"),
  };
}

/** Whether `value` is a valid value for setting `key` (for values coming from a webview). */
export function isValidSetting(key: SettingKey, value: unknown): boolean {
  return Option.isSome(decodeSettings({ ...DEFAULTS, [key]: value }));
}
