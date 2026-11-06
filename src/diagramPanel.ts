import { Option, Schema } from "effect";
import * as vscode from "vscode";
import { onDidChangeLocale, t, webviewL10n } from "./i18n";
import { webviewHtml, webviewRoots } from "./webview";

/** What the diagram page tells the host. */
export type DiagramFromWebview = { type: "ready" } | { type: "hover"; on: boolean };
/** What the host tells the diagram page; `hover` is whether pointing at the diagram highlights its flow. */
export type DiagramToWebview = { type: "diagram"; code: string; hover: boolean };

/** What the diagram page keeps with `setState`, so that the tab comes back after a window reload. */
export const DiagramState = Schema.Struct({ code: Schema.String });
export type DiagramState = typeof DiagramState.Type;

const VIEW_TYPE = "codeAcp.diagram";
/** Whether hover highlighting is on, shared by every diagram tab (on unless turned off). */
const HOVER_KEY = "codeAcp.diagram.hover";

const hoverOn = (state: vscode.Memento) =>
  Option.getOrElse(Schema.decodeUnknownOption(Schema.Boolean)(state.get(HOVER_KEY)), () => true);

/**
 * Opens a ```mermaid block from the chat in an editor tab of its own, where it can be zoomed and panned
 * at full size. Each block gets its own tab; the page is a pure view of `code`, sent whenever it (re)loads.
 */
export function showDiagram(context: vscode.ExtensionContext, code: string): void {
  const { extensionUri } = context;
  const panel = vscode.window.createWebviewPanel(VIEW_TYPE, t("diagram.title"), vscode.ViewColumn.Active, {
    enableScripts: true,
    localResourceRoots: webviewRoots(extensionUri),
  });
  attach(panel, context, code);
}

/** Brings diagram tabs back after a window reload, from the code their page saved. */
export function registerDiagramSerializer(context: vscode.ExtensionContext): vscode.Disposable {
  const { extensionUri } = context;
  return vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
    deserializeWebviewPanel: async (panel, state) => {
      const saved = Schema.decodeUnknownOption(DiagramState)(state);
      if (Option.isNone(saved)) {
        panel.dispose();
        return;
      }
      panel.webview.options = { enableScripts: true, localResourceRoots: webviewRoots(extensionUri) };
      attach(panel, context, saved.value.code);
    },
  });
}

function attach(panel: vscode.WebviewPanel, context: vscode.ExtensionContext, code: string): void {
  const { extensionUri, globalState } = context;
  panel.title = t("diagram.title");
  panel.iconPath = vscode.Uri.joinPath(extensionUri, "media", "icon.svg");
  panel.webview.html = webviewHtml(panel.webview, extensionUri, "diagram");
  const send = (message: DiagramToWebview) => void panel.webview.postMessage(message);
  const disposables = [
    // A hidden tab reloads when shown again, and asks for the diagram once more.
    panel.webview.onDidReceiveMessage((msg: DiagramFromWebview) => {
      if (msg.type === "ready") send({ type: "diagram", code, hover: hoverOn(globalState) });
      else if (msg.type === "hover") void globalState.update(HOVER_KEY, msg.on);
    }),
    onDidChangeLocale(() => {
      panel.title = t("diagram.title");
      void panel.webview.postMessage(webviewL10n());
    }),
  ];
  panel.onDidDispose(() => disposables.forEach((d) => d.dispose()));
}
