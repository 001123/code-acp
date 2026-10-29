import * as vscode from "vscode";
import en, { type MessageKey } from "./l10n/en";
import vi from "./l10n/vi";
import { readSettings } from "./settings";

export type { MessageKey };
export type Locale = "en" | "vi";

const MESSAGES: Record<Locale, Record<MessageKey, string>> = { en, vi };

/** UI language: the codeAcp.language setting, or VS Code's display language when "auto". */
export function locale(): Locale {
  const setting = readSettings().language;
  if (setting !== "auto") {
    return setting;
  }
  return vscode.env.language.toLowerCase().startsWith("vi") ? "vi" : "en";
}

export function t(key: MessageKey, ...args: unknown[]): string {
  return MESSAGES[locale()][key].replace(/\{(\d+)\}/g, (m, i: string) => (+i < args.length ? String(args[+i]) : m));
}

export function onDidChangeLocale(listener: () => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("codeAcp.language")) {
      listener();
    }
  });
}

/** Message for the webviews (src/ui/l10n.ts) carrying the current locale's whole string table. */
export function webviewL10n() {
  const lang = locale();
  return { type: "l10n", lang, strings: MESSAGES[lang] };
}
