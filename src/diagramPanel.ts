import * as vscode from "vscode";
import { onDidChangeLocale, t, webviewL10n } from "./i18n";
import { webviewHtml, webviewRoots } from "./webview";

/** What the diagram page tells the host. */
export type DiagramFromWebview = { type: "ready" };
/** What the host tells the diagram page. */
export type DiagramToWebview = { type: "diagram"; code: string };

/**
 * Opens a ```mermaid block from the chat in an editor tab of its own, where it can be zoomed and panned
 * at full size. Each block gets its own tab; the page is a pure view of `code`, sent whenever it (re)loads.
 */
export function showDiagram(extensionUri: vscode.Uri, code: string): void {
  const panel = vscode.window.createWebviewPanel("codeAcp.diagram", t("diagram.title"), vscode.ViewColumn.Active, {
    enableScripts: true,
    localResourceRoots: webviewRoots(extensionUri),
  });
  panel.iconPath = vscode.Uri.joinPath(extensionUri, "media", "icon.svg");
  panel.webview.html = webviewHtml(panel.webview, extensionUri, "diagram");
  const send = (message: DiagramToWebview) => void panel.webview.postMessage(message);
  const disposables = [
    // A hidden tab reloads when shown again, and asks for the diagram once more.
    panel.webview.onDidReceiveMessage((msg: DiagramFromWebview) => {
      if (msg.type === "ready") send({ type: "diagram", code });
    }),
    onDidChangeLocale(() => {
      panel.title = t("diagram.title");
      void panel.webview.postMessage(webviewL10n());
    }),
  ];
  panel.onDidDispose(() => disposables.forEach((d) => d.dispose()));
}
