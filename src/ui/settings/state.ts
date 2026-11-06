import type { AgentChoice, ProviderChoice } from "../../agentManager";
import type { ApprovalRules, SettingKey, SettingsScope } from "../../settings";
import type { AgentOptions } from "../../sessionOptions";

export interface State {
  values: Partial<Record<SettingKey, unknown>>;
  overridden: SettingKey[];
  workspaceAutoApprove: ApprovalRules;
  /** Which settings `values` are, and those that can't be changed there. */
  scope: SettingsScope;
  hasWorkspace: boolean;
  workspaceName?: string;
  locked: ReadonlyArray<SettingKey>;
  agents: AgentChoice[];
  /** Every agent, enabled or not. */
  providers: ProviderChoice[];
  activeId?: string;
}

/** Options loaded for the agent `agentId` and its model `model`; neither `options` nor `error` while loading. */
export interface Loaded {
  agentId: string;
  model: string;
  options?: AgentOptions;
  error?: string;
}

/** Loaded options by agent and model. */
export type LoadedOptions = Readonly<Record<string, Loaded>>;

export const optionsKey = (agentId: string, model: string) => JSON.stringify([agentId, model]);

/** The setting's value, or `fallback` when it is not a string. */
export function stringOf(state: State, key: SettingKey, fallback = ""): string {
  const value = state.values[key];
  return typeof value === "string" ? value : fallback;
}
