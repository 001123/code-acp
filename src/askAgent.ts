import * as vscode from "vscode";
import { t, type MessageKey } from "./i18n";

/** What "Ask Code ACP" asks the agent about the selected code. */
export type Ask = "explain" | "refactor" | "tests";

/** Each ask's command (editor context menu, palette), lightbulb title and prompt. */
export const ASKS: ReadonlyArray<{ ask: Ask; command: string; title: MessageKey; prompt: MessageKey }> = [
  { ask: "explain", command: "codeAcp.explainSelection", title: "ask.explain", prompt: "ask.explain.prompt" },
  { ask: "refactor", command: "codeAcp.refactorSelection", title: "ask.refactor", prompt: "ask.refactor.prompt" },
  { ask: "tests", command: "codeAcp.testSelection", title: "ask.tests", prompt: "ask.tests.prompt" },
];

/** Offers "Explain / Refactor / Write tests with Code ACP" on a non-empty selection. */
export class AskAgentActions implements vscode.CodeActionProvider {
  static readonly kind = vscode.CodeActionKind.Empty.append("codeAcp");
  static readonly kinds = [AskAgentActions.kind];

  provideCodeActions(_document: vscode.TextDocument, range: vscode.Range | vscode.Selection): vscode.CodeAction[] {
    if (range.isEmpty) {
      return [];
    }
    // The commands read the active editor's selections, which `range` is one of.
    return ASKS.map(({ command, title }) => {
      const action = new vscode.CodeAction(t(title), AskAgentActions.kind);
      action.command = { command, title: t(title) };
      return action;
    });
  }
}
