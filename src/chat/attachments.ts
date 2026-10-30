import type * as acp from "@agentclientprotocol/sdk";
import { Clock, Effect, FileSystem, Option, PlatformError } from "effect";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { t } from "../i18n";
import { thenable, type VscodeError } from "../runtime";
import type { Attachment } from "./protocol";

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const IMAGE_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "image/bmp": ".bmp",
};

/** Pasted attachments and opened images go here, so agents and editors can read them by path. */
const TEMP_DIR = path.join(os.tmpdir(), "code-acp");

/** Temp files older than this are removed on startup; a session rarely goes back to an attachment after a day. */
const TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Text files up to this size are embedded when the agent supports embedded context. */
const MAX_EMBED_BYTES = 256 * 1024;

/** `text` in a code block whose fence is longer than any backtick run in it. */
export function fenced(text: string, language: string): string {
  const fence = "`".repeat(Math.max(3, ...Array.from(text.matchAll(/`+/g), (m) => m[0].length + 1)));
  return `${fence}${language}\n${text}\n${fence}`;
}

/** Writes `data` (base64) to a new temp file named after `name`; returns its path. */
const writeTemp = Effect.fnUntraced(function* (name: string, data: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(TEMP_DIR, { recursive: true });
  const file = path.join(TEMP_DIR, `${yield* Clock.currentTimeMillis}-${name}`);
  yield* fs.writeFile(file, Buffer.from(data, "base64"));
  return file;
});

/** Removes old temp files; the OS may keep them for days. */
export const pruneTempFiles = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const now = yield* Clock.currentTimeMillis;
  const files = yield* fs.readDirectory(TEMP_DIR).pipe(Effect.orElseSucceed(() => []));
  yield* Effect.forEach(
    files,
    (name) => {
      const file = path.join(TEMP_DIR, name);
      return fs.stat(file).pipe(
        Effect.flatMap((info) => {
          const mtime = Option.getOrUndefined(info.mtime)?.getTime();
          return mtime !== undefined && now - mtime > TEMP_MAX_AGE_MS ? fs.remove(file, { force: true }) : Effect.void;
        }),
        Effect.ignore,
      );
    },
    { discard: true },
  );
});

/** Saves a data-URI image to a temp file whose extension the image preview recognizes; undefined if `src` isn't one. */
export const imageToTempFile = Effect.fn("imageToTempFile")(function* (src: string, name: string) {
  const match = /^data:(image\/[\w.+-]+);base64,(.*)$/s.exec(src);
  if (!match) {
    return undefined;
  }
  const [, mimeType, data] = match;
  const base = path.basename(name) || "image";
  return yield* writeTemp(`${base}${path.extname(base) ? "" : (IMAGE_EXT[mimeType!] ?? "")}`, data!);
});

/** Files and folders as composer attachments (Explorer / editor tab context menu). */
export function uriAttachments(uris: ReadonlyArray<vscode.Uri>): Attachment[] {
  return uris.map((uri) => ({ kind: "uri", uri: uri.toString(), name: path.basename(uri.path) }));
}

/** The editor's non-empty selections as snippets. */
export function selectionAttachments(editor: vscode.TextEditor): Attachment[] {
  const doc = editor.document;
  return editor.selections.flatMap((sel): Attachment[] => {
    if (sel.isEmpty) {
      return [];
    }
    // A selection ending at column 0 doesn't really include that line.
    const end = sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line - 1 : sel.end.line;
    const startLine = sel.start.line + 1;
    const endLine = end + 1;
    const range = startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`;
    return [
      {
        kind: "snippet",
        uri: doc.uri.toString(),
        name: `${path.basename(doc.uri.path)}:${range}`,
        languageId: doc.languageId,
        startLine,
        endLine,
        text: doc.getText(sel),
      },
    ];
  });
}

/** The workspace-relative name of the file "include open file" sends, if any. */
export function activeFileName(): string | undefined {
  const uri = vscode.window.activeTextEditor?.document.uri;
  return uri?.scheme === "file" ? vscode.workspace.asRelativePath(uri) : undefined;
}

/** The active editor as context for a prompt: a link to its file, and the selected lines when there are some. */
export function activeFileBlocks(): acp.ContentBlock[] {
  const editor = vscode.window.activeTextEditor;
  const name = activeFileName();
  if (!editor || name === undefined) {
    return [];
  }
  const uri = editor.document.uri;
  const blocks: acp.ContentBlock[] = [{ type: "resource_link", uri: uri.toString(), name }];
  if (!editor.selection.isEmpty) {
    const sel = editor.selection;
    blocks.push({
      type: "text",
      text: `Selection (${name}:${sel.start.line + 1}-${sel.end.line + 1}):\n${editor.document.getText(sel)}`,
    });
  }
  return blocks;
}

/**
 * The prompt block for an attachment, as rich as the agent's prompt capabilities allow: images inline, small text
 * files embedded, anything else as a link to a path the agent can read.
 */
export const attachmentBlock = Effect.fn("attachmentBlock")(function* (
  caps: acp.PromptCapabilities,
  attachment: Attachment,
): Effect.fn.Return<acp.ContentBlock, VscodeError | PlatformError.PlatformError, FileSystem.FileSystem> {
  if (attachment.kind === "data") {
    if (attachment.mimeType.startsWith("image/") && caps.image) {
      return { type: "image", mimeType: attachment.mimeType, data: attachment.data };
    }
    // No path to point at: save to a temp file so any agent can read it via resource_link.
    const file = yield* writeTemp(path.basename(attachment.name) || "attachment", attachment.data);
    return {
      type: "resource_link",
      uri: vscode.Uri.file(file).toString(),
      name: attachment.name,
      mimeType: attachment.mimeType || undefined,
    };
  }

  if (attachment.kind === "terminal") {
    const { terminal, shell, commandLine, cwd, exitCode, text } = attachment;
    const facts = [shell && `shell ${shell}`, cwd && `cwd ${cwd}`, exitCode !== undefined && `exit code ${exitCode}`].filter(Boolean).join(", ");
    const where = `terminal "${terminal}"${facts ? ` (${facts})` : ""}`;
    const title = commandLine === undefined ? `Selection in ${where}` : `Command in ${where}`;
    const body = commandLine === undefined ? text : `$ ${commandLine}\n${text}`;
    return { type: "text", text: `${title}:\n${fenced(body, "console")}` };
  }
  if (attachment.kind === "problems") {
    return { type: "text", text: `Problems reported by VS Code:\n${fenced(attachment.text, "text")}` };
  }
  const uri = vscode.Uri.parse(attachment.uri);
  const name = uri.scheme === "file" ? vscode.workspace.asRelativePath(uri) : attachment.name;
  if (attachment.kind === "snippet") {
    const { startLine, endLine, text } = attachment;
    const lines = startLine === endLine ? `L${startLine}` : `L${startLine}-${endLine}`;
    if (caps.embeddedContext) {
      return { type: "resource", resource: { uri: uri.with({ fragment: lines }).toString(), text } };
    }
    return { type: "text", text: `${name}#${lines}\n${fenced(text, attachment.languageId)}` };
  }
  const stat = yield* thenable(() => vscode.workspace.fs.stat(uri));
  if (stat.type & vscode.FileType.Directory) {
    return { type: "resource_link", uri: uri.toString(), name: `${name}/`, description: t("chat.folder") };
  }
  const imageMime = IMAGE_MIME[path.extname(uri.path).toLowerCase()];
  if (imageMime && caps.image) {
    const bytes = yield* thenable(() => vscode.workspace.fs.readFile(uri));
    return { type: "image", mimeType: imageMime, data: Buffer.from(bytes).toString("base64"), uri: uri.toString() };
  }
  if (!imageMime && caps.embeddedContext && stat.size <= MAX_EMBED_BYTES) {
    const bytes = yield* thenable(() => vscode.workspace.fs.readFile(uri));
    if (!bytes.includes(0)) {
      return { type: "resource", resource: { uri: uri.toString(), text: new TextDecoder().decode(bytes) } };
    }
  }
  return { type: "resource_link", uri: uri.toString(), name, size: stat.size, mimeType: imageMime };
});

/** Attachments added from VS Code (context menus, terminal picks) while the webview may not be ready yet. */
export class AttachmentQueue {
  private queued: Attachment[] = [];

  constructor(private readonly deliver: (attachments: Attachment[]) => boolean) {}

  add(attachments: ReadonlyArray<Attachment>): void {
    this.queued.push(...attachments);
    this.flush();
  }

  /** Hands the queued attachments to the webview, when there is one. */
  flush(): void {
    if (this.queued.length && this.deliver(this.queued)) {
      this.queued = [];
    }
  }
}
