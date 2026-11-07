import * as vscode from "vscode";
import { locale, t } from "./i18n";
import type { Totals } from "./usageLedger";

export interface UsageStatusView {
  readonly text: string;
  readonly tooltip: string;
}

/** `tab`: what the active tab's session recorded, undefined until it has any. `today`: what every session recorded today. */
export function usageStatusView(tab: Totals | undefined, today: Totals): UsageStatusView {
  const compact = new Intl.NumberFormat(locale(), { notation: "compact", maximumFractionDigits: 1 });
  const exact = new Intl.NumberFormat(locale());
  const [tokens, turns] = [tab?.tokens.total ?? 0, tab?.turns ?? 0];
  const lines = [
    t("statusBar.usageTab", exact.format(tokens), exact.format(turns)),
    t("statusBar.usageToday", exact.format(today.tokens.total), exact.format(today.turns)),
    "",
    t("chat.showUsage"),
  ];
  return {
    text: `$(graph) ${t("usage.tileDetail", compact.format(tokens), exact.format(turns))}`,
    tooltip: lines.join("\n"),
  };
}

/** The status bar item with the active tab's tokens and turns; clicking it runs `command`, which opens the usage page. */
export class UsageStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem("kdCode.usage", vscode.StatusBarAlignment.Right, 99);

  constructor(command: string) {
    this.item.command = command;
  }

  show(tab: Totals | undefined, today: Totals): void {
    const view = usageStatusView(tab, today);
    this.item.name = t("statusBar.usageName");
    this.item.text = view.text;
    this.item.tooltip = view.tooltip;
    this.item.accessibilityInformation = { label: view.tooltip.replace(/\n+/g, ". ") };
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}
