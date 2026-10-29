import * as vscode from "vscode";
import { onDidChangeLocale, t } from "./i18n";

/**
 * Native tree view used as a drop target. Since VS Code 1.140 drags from the Explorer no longer
 * reach webviews (microsoft/vscode#339036), but tree views still receive them.
 */
export class DropViewProvider
  implements vscode.TreeDataProvider<string>, vscode.TreeDragAndDropController<string>, vscode.Disposable
{
  static readonly viewId = "codeAcp.drop";

  readonly dropMimeTypes = ["text/uri-list", "files"];
  readonly dragMimeTypes: string[] = [];

  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly localeSub = onDidChangeLocale(() => this.changed.fire());

  constructor(private readonly attach: (uris: ReadonlyArray<vscode.Uri>) => Promise<void>) {}

  dispose(): void {
    this.localeSub.dispose();
    this.changed.dispose();
  }

  getChildren(element?: string): string[] {
    return element ? [] : ["hint", "info"];
  }

  getTreeItem(element: string): vscode.TreeItem {
    if (element === "info") {
      const item = new vscode.TreeItem("");
      item.iconPath = new vscode.ThemeIcon("info");
      item.description = t("drop.infoLabel");
      item.tooltip = new vscode.MarkdownString(t("drop.infoTooltip"));
      return item;
    }
    const item = new vscode.TreeItem(t("drop.label"));
    item.iconPath = new vscode.ThemeIcon("cloud-upload", new vscode.ThemeColor("textLink.foreground"));
    item.tooltip = t("drop.tooltip");
    return item;
  }

  async handleDrop(_target: string | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
    const uris = new Map<string, vscode.Uri>();
    const list = await dataTransfer.get("text/uri-list")?.asString();
    for (const line of list?.split(/\r?\n/) ?? []) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) {
        const uri = vscode.Uri.parse(trimmed);
        uris.set(uri.toString(), uri);
      }
    }
    // Drops from the OS arrive as files; local ones carry their uri.
    dataTransfer.forEach((item) => {
      const uri = item.asFile()?.uri;
      if (uri) {
        uris.set(uri.toString(), uri);
      }
    });
    if (uris.size) {
      await this.attach([...uris.values()]);
    }
  }
}
