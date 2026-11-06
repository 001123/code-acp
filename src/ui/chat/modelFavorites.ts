import { getState, setState } from "../vscode";

/** A starred model: the agent's id, the model's value, and its name for when that agent is not running. */
export interface FavoriteModel {
  agent: string;
  value: string;
  name: string;
}

/** The favorites this webview kept before they were a setting, taken out of its state to be moved there once. */
export function takeSavedFavorites(): unknown[] | undefined {
  const state = getState() as { modelFavorites?: unknown } | undefined;
  const saved = state?.modelFavorites;
  if (!Array.isArray(saved)) return undefined;
  const { modelFavorites: _, ...rest } = state!;
  setState(rest);
  return saved.length ? saved : undefined;
}
