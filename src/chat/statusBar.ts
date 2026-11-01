import * as vscode from "vscode";
import { t } from "../i18n";

/** What the status bar item shows: the active tab's model and effort, and what the tabs are doing; the agent is in the tooltip. */
export interface ChatStatus {
  /** Name of the active tab's agent; undefined when there is none. */
  readonly agent?: string;
  /** The model the active tab's session runs on, when the agent offers a model picker. */
  readonly model?: string;
  /** The active tab's level of thinking, when the agent offers one. */
  readonly effort?: string;
  /** Tabs waiting for a permission answer. */
  readonly waiting: number;
  /** Tabs whose turn ended while the user looked elsewhere. */
  readonly finished: number;
  /** Tabs running a turn. */
  readonly running: number;
}

export interface StatusBarView {
  readonly text: string;
  readonly tooltip: string;
  /** Shown on the warning background: a tab waits for the user. */
  readonly warning: boolean;
}

export function statusBarView(status: ChatStatus): StatusBarView {
  const { agent, model, effort, waiting, finished, running } = status;
  const icon = waiting ? "$(bell-dot)" : running ? "$(loading~spin)" : finished ? "$(bell)" : "$(comment-discussion)";
  const label = [model, effort].filter((part) => part !== undefined).join(" · ");
  const lines = [
    t("statusBar.agent", agent ?? t("statusBar.noAgent")),
    ...(model ? [t("statusBar.model", model)] : []),
    ...(effort ? [t("statusBar.effort", effort)] : []),
    ...(waiting ? [t("statusBar.waiting", waiting)] : []),
    ...(finished ? [t("statusBar.finished", finished)] : []),
    ...(running ? [t("statusBar.running", running)] : []),
    ...(waiting || finished || running ? [] : [t("statusBar.idle")]),
    "",
    t(waiting || finished ? "statusBar.showAttention" : "statusBar.showChat"),
  ];
  return { text: label ? `${icon} ${label}` : icon, tooltip: lines.join("\n"), warning: waiting > 0 };
}

/** The chat's status bar item; clicking it runs `command`, which brings up the tab that needs the user. */
export class ChatStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor(command: string) {
    this.item = vscode.window.createStatusBarItem("codeAcp.status", vscode.StatusBarAlignment.Right, 100);
    this.item.name = t("statusBar.name");
    this.item.command = command;
  }

  show(status: ChatStatus): void {
    const view = statusBarView(status);
    this.item.name = t("statusBar.name");
    this.item.text = view.text;
    this.item.tooltip = view.tooltip;
    this.item.accessibilityInformation = { label: view.tooltip.replace(/\n+/g, ". ") };
    this.item.backgroundColor = view.warning ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}
