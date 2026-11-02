import { Effect, Option } from "effect";
import * as path from "node:path";
import * as vscode from "vscode";
import { t } from "../i18n";
import { thenable } from "../runtime";
import { excludeGlob, gitIgnored, resolvePath } from "../workspace";

/** Workspace files ending in `file`, git-ignored ones left out: the only match, the picked one, `null` if the pick was dismissed. */
const findInWorkspace = Effect.fn("findInWorkspace")(function* (file: string) {
  const name = file.replace(/^\.\//, "").replace(/\/$/, "");
  if (!name || name.split("/").includes("..")) {
    return undefined;
  }
  // Brackets and braces in a name are glob syntax; `[x]` matches the character itself.
  const glob = `**/${name.replace(/[[\]{}]/g, "[$&]")}`;
  const found = yield* thenable(() => vscode.workspace.findFiles(glob, excludeGlob(), 50));
  // Build output and other ignored files only when nothing else matches.
  const ignored = yield* gitIgnored(found);
  const kept = found.filter((uri) => !ignored.has(uri.fsPath));
  const uris = kept.length > 0 ? kept : found;
  if (uris.length <= 1) {
    return uris[0];
  }
  const items = uris
    .map((uri) => ({ label: vscode.workspace.asRelativePath(uri), uri }))
    .sort((a, b) => a.label.length - b.label.length || a.label.localeCompare(b.label));
  const picked = yield* thenable(() => vscode.window.showQuickPick(items, { title: t("chat.pickFile", name) }));
  return picked?.uri ?? null;
});

/**
 * Opens a file in an editor (at `line` when given) or reveals a folder in the Explorer. Relative paths start at
 * `cwd`. A relative path missing there (agents often write a bare `protocol.ts`) is looked up in the workspace;
 * several matches are offered in a pick.
 */
export const openFile = Effect.fn("openFile")(function* (file: string, line: number | undefined, cwd: string) {
  let uri = vscode.Uri.file(resolvePath(file, cwd));
  let stat = yield* thenable(() => vscode.workspace.fs.stat(uri)).pipe(Effect.option);
  if (Option.isNone(stat) && !path.isAbsolute(file) && !file.startsWith("~/")) {
    const found = yield* findInWorkspace(file);
    if (found) {
      uri = found;
      stat = yield* thenable(() => vscode.workspace.fs.stat(uri)).pipe(Effect.option);
    } else if (found === null) {
      return;
    }
  }
  if (Option.isNone(stat)) {
    vscode.window.setStatusBarMessage(t("chat.fileNotFound", file), 4000);
    return;
  }
  if (stat.value.type & vscode.FileType.Directory) {
    yield* thenable(() => vscode.commands.executeCommand("revealInExplorer", uri));
    return;
  }
  const position = line ? new vscode.Position(line - 1, 0) : undefined;
  // `vscode.open` picks the editor by file type, so images and other binaries open in their viewer.
  const options: vscode.TextDocumentShowOptions = position ? { selection: new vscode.Range(position, position) } : {};
  yield* thenable(() => vscode.commands.executeCommand("vscode.open", uri, options));
});
