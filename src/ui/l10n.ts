import { useSyncExternalStore } from "react";
import type { MessageKey } from "../l10n/en";

export type { MessageKey };

interface Table {
  readonly lang: string;
  readonly strings: Partial<Record<MessageKey, string>>;
}

/** Initial table from the `#l10n-data` block; replaced when the extension posts { type: "l10n" }. */
let table: Table = JSON.parse(document.getElementById("l10n-data")?.textContent || '{"lang":"en","strings":{}}');
const listeners = new Set<() => void>();

function apply(): void {
  document.documentElement.lang = table.lang;
}
apply();

window.addEventListener("message", (e) => {
  if (e.data?.type === "l10n") {
    table = { lang: e.data.lang, strings: e.data.strings };
    apply();
    for (const f of listeners) f();
  }
});

function subscribe(f: () => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

export type Translate = (key: MessageKey, ...args: unknown[]) => string;

function translate(strings: Table["strings"]): Translate {
  return (key, ...args) =>
    (strings[key] ?? key).replace(/\{(\d+)\}/g, (m, i: string) => (+i < args.length ? String(args[+i]) : m));
}

/** Current language and `t()`; re-renders the caller after a language change. */
export function useL10n(): { lang: string; t: Translate } {
  const current = useSyncExternalStore(subscribe, () => table);
  return { lang: current.lang, t: translate(current.strings) };
}
