import { Effect } from "effect";
import * as path from "node:path";
import * as vscode from "vscode";
import { t } from "../i18n";
import { thenable } from "../runtime";
import type { Tab } from "./tabs";

/** A file name that works everywhere, from a conversation's title. */
export function exportFileName(title: string | undefined): string {
  const name = (title ?? "")
    .replace(/[\\/:*?"<>|\p{Cc}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 80)
    .trim();
  return `${name || t("chat.exportDefaultName")}.md`;
}

/** Asks where to save the Markdown of `tab`'s conversation, writes it, and offers to open it. */
export const saveConversation = Effect.fn("saveConversation")(function* (tab: Tab, markdown: string) {
  if (!markdown) {
    void vscode.window.showInformationMessage(t("chat.exportEmpty"));
    return;
  }
  const target = yield* thenable(() =>
    vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(tab.cwd, exportFileName(tab.name ?? tab.title))),
      filters: { [t("chat.exportFilter")]: ["md"] },
    }),
  );
  if (!target) {
    return;
  }
  yield* thenable(() => vscode.workspace.fs.writeFile(target, new TextEncoder().encode(markdown)));
  const open = t("chat.exportOpen");
  const picked = yield* thenable(() =>
    vscode.window.showInformationMessage(t("chat.exported", path.basename(target.path)), open),
  );
  if (picked === open) {
    yield* thenable(() => vscode.commands.executeCommand("vscode.open", target));
  }
});
