import type { AttemptPick } from "../../chat/protocol";
import type { AgentOptions, Choice } from "../../sessionOptions";

/** A row of the comparison's popover. */
export interface AttemptRow {
  id: number;
  agentId: string;
  /** Empty: what the agent's sessions usually start with. */
  model: string;
  effort: string;
}

/** What the agent offers with `model`; neither `options` nor `error` while it is asked. */
export interface LoadedAttempt {
  agentId: string;
  model: string;
  options?: AgentOptions;
  error?: string;
}

export type LoadedAttempts = Readonly<Record<string, LoadedAttempt>>;

export const attemptKey = (agentId: string, model: string) => JSON.stringify([agentId, model]);

/** The agent's models; they don't depend on the model asked with, so any answer will do while another loads. */
export function modelsIn(loaded: LoadedAttempts, agentId: string): ReadonlyArray<Choice> | undefined {
  return Object.values(loaded).find((each) => each.agentId === agentId && each.options)?.options?.models;
}

/** The row to add: an agent not in the comparison yet, else the last row's agent with a model not in it yet. */
export function nextRow(
  id: number,
  rows: ReadonlyArray<AttemptRow>,
  agentIds: ReadonlyArray<string>,
  modelsOf: (agentId: string) => ReadonlyArray<Choice> | undefined,
): AttemptRow {
  const fresh = agentIds.find((agentId) => !rows.some((row) => row.agentId === agentId));
  if (fresh !== undefined) return { id, agentId: fresh, model: "", effort: "" };
  const agentId = rows.at(-1)?.agentId ?? agentIds[0]!;
  const model = modelsOf(agentId)?.find((m) => !rows.some((row) => row.agentId === agentId && row.model === m.value));
  return { id, agentId, model: model?.value ?? "", effort: "" };
}

/** The row as the host takes it, with a label from the names the agent gives its model and effort. */
export function attemptPick(row: AttemptRow, loaded: LoadedAttempts, modelsOf: (agentId: string) => ReadonlyArray<Choice> | undefined): AttemptPick {
  const { agentId, model, effort } = row;
  const options = loaded[attemptKey(agentId, model)]?.options;
  const modelName = model && (modelsOf(agentId)?.find((m) => m.value === model)?.name ?? model);
  // An effort the model turned out not to have won't be set.
  const effortName = effort && (options ? options.efforts.find((e) => e.value === effort)?.name : effort);
  const label = [modelName, effortName].filter(Boolean).join(" · ");
  return { agentId, model, effort, ...(label ? { label } : {}) };
}
