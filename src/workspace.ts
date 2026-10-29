import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

/** A workspace folder a chat tab can run its session in. */
export interface Folder {
  readonly name: string;
  readonly path: string;
}

/**
 * Workspace folders on disk, in workspace order. Virtual folders (vscode-vfs, untitled) have no path an agent
 * process could work in. In a remote window the extension runs on the remote side, where its folders are `file:`.
 */
export function workspaceFolders(): Folder[] {
  return (vscode.workspace.workspaceFolders ?? [])
    .filter((f) => f.uri.scheme === "file")
    .map((f) => ({ name: f.name, path: f.uri.fsPath }));
}

/** The workspace folder holding `file`, the innermost one when folders are nested. */
export function folderOf(file: string): Folder | undefined {
  const inside = (folder: Folder) => {
    const relative = path.relative(folder.path, file);
    return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  };
  return workspaceFolders()
    .filter(inside)
    .sort((a, b) => b.path.length - a.path.length)[0];
}

/** Where a new session runs when nothing says otherwise: the first workspace folder, else the home folder. */
export function defaultCwd(): string {
  return workspaceFolders()[0]?.path ?? os.homedir();
}

/** The folder for a new tab: the active editor's, else the one holding `fallback`, else the default. */
export function cwdForNewTab(fallback: string | undefined): string {
  const editor = vscode.window.activeTextEditor?.document.uri;
  const fromEditor = editor?.scheme === "file" ? folderOf(editor.fsPath) : undefined;
  if (fromEditor) {
    return fromEditor.path;
  }
  return (fallback !== undefined ? folderOf(fallback)?.path : undefined) ?? defaultCwd();
}

export function isWorkspaceFolder(cwd: string): boolean {
  return workspaceFolders().some((f) => f.path === cwd);
}

/** Resolves a path from agent output: "~/" is the home folder, relative paths start at `cwd`. */
export function resolvePath(file: string, cwd: string): string {
  return file.startsWith("~/") ? path.join(os.homedir(), file.slice(2)) : path.resolve(cwd, file);
}
