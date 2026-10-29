import type { Attachment } from "../../chat/protocol";
import type { Translate } from "../l10n";

export function nameFromUri(uri: string): string {
  const parts = decodeURIComponent(uri.replace(/[?#].*$/, "")).split("/").filter(Boolean);
  return parts[parts.length - 1] ?? uri;
}

/** Data URI of an image attachment, if it is one. */
export function imageSrc(a: Attachment): string | undefined {
  return a.kind === "data" && a.mimeType.startsWith("image/") ? `data:${a.mimeType};base64,${a.data}` : undefined;
}

/** Identifies attachments that are the same file or range; raw data never dedupes. */
export function attachmentKey(a: Attachment): string | undefined {
  switch (a.kind) {
    case "uri":
      return a.uri;
    case "snippet":
      return `${a.uri}#L${a.startLine}-${a.endLine}`;
    case "data":
    case "terminal":
      return undefined;
  }
}

const MAX_TITLE_CHARS = 500;

export function attachmentTitle(t: Translate, a: Attachment): string {
  switch (a.kind) {
    case "uri":
      return a.uri;
    case "snippet":
    case "terminal":
      return a.text.length > MAX_TITLE_CHARS ? `${a.text.slice(0, MAX_TITLE_CHARS)}…` : a.text;
    case "data":
      return `${a.name} (${a.mimeType || t("chat.unknownType")})`;
  }
}

/**
 * Replaces `start`..`end` of the textarea with `text`, caret after it. Goes through the editing commands
 * (deprecated, but the only way) so the change lands on the native undo stack; `setRangeText` would not.
 */
export function editText(el: HTMLTextAreaElement, text: string, start: number, end: number): void {
  el.focus();
  el.setSelectionRange(start, end);
  if (!document.execCommand(text ? "insertText" : "delete", false, text)) el.setRangeText(text, start, end, "end");
}

/** URIs from VS Code (explorer, tabs) or other apps, one per line; "#" lines are comments. */
export function urisFrom(dt: DataTransfer): string[] {
  const raw = dt.getData("application/vnd.code.uri-list") || dt.getData("text/uri-list");
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}
