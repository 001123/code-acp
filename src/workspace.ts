import { Effect } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
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

/** Glob of the folders `files.exclude` and `search.exclude` hide; ignore files are not read. */
export function excludeGlob(): string {
  const config = vscode.workspace.getConfiguration();
  const globs = new Set(["**/.git"]);
  for (const key of ["files.exclude", "search.exclude"]) {
    for (const [glob, on] of Object.entries(config.get<Record<string, unknown>>(key) ?? {})) {
      if (on === true) globs.add(glob);
    }
  }
  return `{${[...globs].join(",")}}`;
}

/**
 * The files of `uris` that git ignores (`.gitignore`, `info/exclude`, `core.excludesFile`), as paths. Files
 * outside a git repository, or when git is missing, count as not ignored.
 */
export const gitIgnored = Effect.fn("gitIgnored")(function* (uris: ReadonlyArray<vscode.Uri>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const byFolder = new Map<string, Array<string>>();
  for (const uri of uris) {
    const folder = folderOf(uri.fsPath);
    if (folder) {
      byFolder.set(folder.path, [...(byFolder.get(folder.path) ?? []), uri.fsPath]);
    }
  }
  const outputs = yield* Effect.forEach(
    byFolder,
    ([cwd, files]) =>
      spawner
        .string(ChildProcess.make("git", ["-c", "core.quotePath=false", "check-ignore", "--", ...files], { cwd }))
        .pipe(Effect.orElseSucceed(() => "")),
    { concurrency: "unbounded" },
  );
  return new Set(outputs.flatMap((out) => out.split("\n").filter(Boolean).map((file) => path.resolve(file))));
});
