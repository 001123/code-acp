import { useState } from "react";
import { getState, setState } from "../vscode";

/** A model starred in the picker: the agent's id, the model's value, and its name for when that agent is not running. */
export interface FavoriteModel {
  agent: string;
  value: string;
  name: string;
}

const read = (): ReadonlyArray<FavoriteModel> => {
  const saved = (getState() as { modelFavorites?: unknown } | undefined)?.modelFavorites;
  return Array.isArray(saved)
    ? saved.filter(
        (f): f is FavoriteModel =>
          typeof f === "object" &&
          f !== null &&
          typeof f.agent === "string" &&
          typeof f.value === "string" &&
          typeof f.name === "string",
      )
    : [];
};

/** The starred models, kept in the webview's state, and a toggle for one. */
export function useModelFavorites(): [ReadonlyArray<FavoriteModel>, (favorite: FavoriteModel) => void] {
  const [favorites, set] = useState(read);
  return [
    favorites,
    (favorite) => {
      const has = favorites.some((f) => f.agent === favorite.agent && f.value === favorite.value);
      const next = has
        ? favorites.filter((f) => f.agent !== favorite.agent || f.value !== favorite.value)
        : [...favorites, favorite];
      set(next);
      setState({ ...(getState() as object | undefined), modelFavorites: next });
    },
  ];
}
