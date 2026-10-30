import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { locale, webviewL10n } from "./i18n";

export function nonce(): string {
  return randomBytes(16).toString("hex");
}

/** Folders a webview may load from: media/ (icons) and dist/webview/ (React and CSS bundles). */
export function webviewRoots(extensionUri: vscode.Uri): vscode.Uri[] {
  return [vscode.Uri.joinPath(extensionUri, "media"), vscode.Uri.joinPath(extensionUri, "dist", "webview")];
}

/**
 * Page shell for a React webview: dist/webview/<page>.css (bundled from media/<page>.css), the string table and dist/webview/<page>.js,
 * which renders into #root. `imgSrc` extends the CSP's img-src.
 */
export function webviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, page: string, imgSrc = ""): string {
  const n = nonce();
  const style = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", "webview", `${page}.css`));
  const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", "webview", `${page}.js`));
  // A JSON data block is never executed, so CSP does not apply; escape "<" so it cannot close the tag.
  const data = JSON.stringify(webviewL10n()).replace(/</g, "\\u003c");
  // style-src-attr: Mermaid SVGs from pele carry their theme variables in style attributes.
  const img = imgSrc ? `img-src ${imgSrc}; ` : "";
  return `<!DOCTYPE html>
<html lang="${locale()}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; ${img}style-src ${webview.cspSource}; style-src-attr 'unsafe-inline'; script-src 'nonce-${n}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${style}" rel="stylesheet">
</head>
<body>
<div id="root"></div>
<script type="application/json" id="l10n-data">${data}</script>
<script nonce="${n}" src="${script}"></script>
</body>
</html>`;
}
