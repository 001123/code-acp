import type { Attachment } from "../../chat/protocol";
import type { Translate } from "../l10n";
import { nameFromUri, urisFrom } from "./attachments";

const MAX_DATA_BYTES = 20 * 1024 * 1024;

/** Where files dropped or pasted in the composer go. */
export interface FileIntake {
  /** The extension runs on another machine (Remote SSH, WSL, containers), which can't read paths on this one. */
  remote: boolean;
  attach: (a: Attachment) => void;
  error: (key: Parameters<Translate>[0], ...args: unknown[]) => void;
}

function readFile(file: File, intake: FileIntake): void {
  if (file.size > MAX_DATA_BYTES) {
    intake.error("chat.tooLarge", file.name);
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const result = String(reader.result);
    intake.attach({
      kind: "data",
      name: file.name || `clipboard-${Date.now()}.${(file.type.split("/")[1] || "bin").replace(/\W.*$/, "")}`,
      mimeType: file.type,
      data: result.slice(result.indexOf(",") + 1),
    });
  };
  reader.onerror = () => intake.error("chat.readFailed", file.name);
  reader.readAsDataURL(file);
}

/** Handles a DataTransfer from drop or paste. Returns true when something was attached. */
export function takeTransfer(dt: DataTransfer, intake: FileIntake): boolean {
  const items = Array.from(dt.items ?? []).filter((it) => it.kind === "file");
  // VS Code's own list (Explorer, editor tabs) names files where the extension runs; files dropped from the
  // OS of a remote window are on this machine, so they go as their bytes.
  const local = intake.remote && items.length > 0 && !dt.types.includes("application/vnd.code.uri-list");
  const uris = local ? [] : urisFrom(dt);
  if (uris.length) {
    for (const uri of uris) intake.attach({ kind: "uri", uri, name: nameFromUri(uri) });
    return true;
  }
  if (!items.length) return false;
  for (const item of items) {
    if (item.webkitGetAsEntry?.()?.isDirectory) {
      intake.error("chat.externalFolder");
      continue;
    }
    const file = item.getAsFile();
    if (file) readFile(file, intake);
  }
  return true;
}
