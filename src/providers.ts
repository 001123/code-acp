import { Effect, Option, Schema } from "effect";
import * as vscode from "vscode";
import { thenable } from "./runtime";
import { FavoriteModel, ProviderPrefs } from "./settings";

const decodeEntries = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown));
const decodeProvider = Schema.decodeUnknownOption(ProviderPrefs);
const decodeFavorites = Schema.decodeUnknownOption(Schema.Array(FavoriteModel));

/** The usable codeAcp.providers entries by agent id, decoded one by one so a bad entry does not drop the others. */
export const providerPrefs = (): ReadonlyMap<string, ProviderPrefs> => {
  const raw = vscode.workspace.getConfiguration("codeAcp").get("providers");
  const prefs = new Map<string, ProviderPrefs>();
  for (const [id, value] of Object.entries(Option.getOrElse(decodeEntries(raw ?? {}), () => ({})))) {
    const entry = decodeProvider(value);
    if (Option.isSome(entry)) prefs.set(id, entry.value);
  }
  return prefs;
};

/** Whether the agent `id` is enabled: it is unless codeAcp.providers turns it off. */
export const isProviderEnabled = (id: string): boolean => providerPrefs().get(id)?.enabled !== false;

/** Writes `change` of the prefs of agent `id` to the user's settings; an entry left empty is removed. */
export const updateProvider = (id: string, change: (prefs: ProviderPrefs) => ProviderPrefs) =>
  Effect.gen(function* () {
    const all = Object.fromEntries(providerPrefs());
    const next = Object.fromEntries(
      Object.entries(change(all[id] ?? {})).filter(([, v]) => v !== undefined && !(Array.isArray(v) && !v.length)),
    );
    const { [id]: _, ...others } = all;
    const value = Object.keys(next).length ? { ...others, [id]: next } : others;
    yield* thenable(() =>
      vscode.workspace
        .getConfiguration("codeAcp")
        .update("providers", Object.keys(value).length ? value : undefined, vscode.ConfigurationTarget.Global),
    );
  });

/** Stars the model `favorite` of agent `id`, or takes its star away. */
export const toggleFavorite = (id: string, favorite: FavoriteModel) =>
  updateProvider(id, (prefs) => {
    const favorites = prefs.favorites ?? [];
    return {
      ...prefs,
      favorites: favorites.some((f) => f.value === favorite.value)
        ? favorites.filter((f) => f.value !== favorite.value)
        : [...favorites, favorite],
    };
  });

/** Adds favorites starred before they were a setting (kept by the chat webview), by agent id. */
export const importFavorites = (raw: unknown) =>
  Effect.gen(function* () {
    if (!Array.isArray(raw)) return;
    const byAgent = new Map<string, Array<FavoriteModel>>();
    for (const item of raw) {
      const agent = (item as { agent?: unknown } | null)?.agent;
      const favorite = decodeFavorites([item]);
      if (typeof agent !== "string" || Option.isNone(favorite)) continue;
      const { value, name } = favorite.value[0]!;
      byAgent.set(agent, [...(byAgent.get(agent) ?? []), { value, name }]);
    }
    for (const [agent, favorites] of byAgent) {
      yield* updateProvider(agent, (prefs) => {
        const have = prefs.favorites ?? [];
        return { ...prefs, favorites: [...have, ...favorites.filter((f) => !have.some((h) => h.value === f.value))] };
      });
    }
  });
