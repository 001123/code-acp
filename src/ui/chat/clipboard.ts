import type { Attachment } from "../../chat/protocol";
import { splitTokens } from "../markdown";
import type { Token } from "./tokens";

/** Marks HTML copied from a chat message, so pasting it in the composer brings its images back. */
export const COPIED_ATTR = "data-code-acp-message";

/** An image token in copied HTML. */
export interface CopiedImage {
  token: string;
  src: string;
}

/** An attachment and the token that stands for it in copied text. */
export interface CopiedToken {
  token: string;
  attachment: Attachment;
}

/** The data attachment a `data:` URI holds, if it is a base64 image. */
export function imageAttachment(name: string, src: string): Extract<Attachment, { kind: "data" }> | undefined {
  const m = /^data:(image\/[\w.+-]+);base64,(.*)$/s.exec(src);
  return m ? { kind: "data", name, mimeType: m[1]!, data: m[2]! } : undefined;
}

/** A token's name, without its sigil and the number that told it from another of the same name. */
const tokenName = (token: string) => token.slice(1).replace(/ \(\d+\)$/, "");

/** The images that can be read back as attachments. */
export function imageTokens(images: readonly CopiedImage[]): CopiedToken[] {
  return images.flatMap(({ token, src }) => {
    const attachment = imageAttachment(tokenName(token), src);
    return attachment ? [{ token, attachment }] : [];
  });
}

/**
 * The composer content of pasted text: `text` with the tokens of `copied` as attachments, each renamed like a new one
 * ("@image.png (2)") when `taken` already has it.
 */
export function pastedContent(
  text: string,
  copied: readonly CopiedToken[],
  taken: (token: string) => boolean,
): { text: string; inline: CopiedToken[] } {
  const inline: CopiedToken[] = [];
  const names = new Map<string, string>();
  const used = (token: string) => taken(token) || inline.some((x) => x.token === token);
  for (const { token, attachment } of copied) {
    if (names.has(token) || !text.includes(token)) continue;
    const name = tokenName(token);
    let next = `${token[0]}${name}`;
    for (let n = 2; used(next); n++) next = `${token[0]}${name} (${n})`;
    names.set(token, next);
    inline.push({ token: next, attachment });
  }
  const parts = splitTokens(
    text,
    [...names.keys()].map((token) => ({ token })),
  );
  return { text: parts.map((p) => (typeof p === "string" ? p : names.get(p.token)!)).join(""), inline };
}

/** The bytes of a `data:` image as PNG, the only image type the clipboard takes. */
async function pngOf(src: string): Promise<Blob> {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(src);
  if (!m) throw new Error("not a base64 data URI");
  const bytes = Uint8Array.from(atob(m[2]!), (c) => c.charCodeAt(0));
  const blob = new Blob([bytes], { type: m[1] });
  if (blob.type === "image/png") return blob;
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvas.convertToBlob({ type: "image/png" });
}

/** Image tokens drawn in the transcript, with the image each stands for. */
export const tokenImages = new WeakMap<Element, string>();

/**
 * Replaces the token marks in `root`, a copy of rendered messages, with the images `srcs` gives in the same order;
 * marks without one, or cut by a selection, become their text. Returns the images put in.
 */
function inlineImages(root: ParentNode, srcs: ReadonlyArray<string | undefined>): string[] {
  const put: string[] = [];
  [...root.querySelectorAll<HTMLElement>("mark.token")].forEach((mark, i) => {
    const token = mark.dataset.token;
    const src = srcs[i];
    if (!token || !src || mark.textContent !== token) {
      mark.replaceWith(mark.textContent ?? "");
      return;
    }
    const img = document.createElement("img");
    img.src = src;
    img.alt = token.slice(1);
    img.dataset.token = token;
    mark.replaceWith(img);
    put.push(src);
  });
  return put;
}

/** `root` as copied HTML, marked so the composer knows it. */
function copiedHtml(root: HTMLElement): string {
  root.setAttribute(COPIED_ATTR, "");
  return root.outerHTML;
}

/**
 * Copies a user message: its Markdown as plain text and, when it has images, its rendered `body` as HTML with the
 * images in it; a single image also goes as PNG, for apps that only take an image.
 */
export async function copyMessage(
  text: string,
  tokens: readonly Token[],
  body: Element | null | undefined,
): Promise<void> {
  const images = new Map(tokens.flatMap((x) => (x.src?.startsWith("data:image/") ? [[x.token, x.src] as const] : [])));
  if (!body || images.size === 0) return navigator.clipboard.writeText(text);
  const root = body.cloneNode(true) as HTMLElement;
  const put = inlineImages(
    root,
    [...root.querySelectorAll<HTMLElement>("mark.token")].map((m) => images.get(m.dataset.token ?? "")),
  );
  const data: Record<string, Blob | Promise<Blob>> = {
    "text/plain": new Blob([text], { type: "text/plain" }),
    "text/html": new Blob([copiedHtml(root)], { type: "text/html" }),
  };
  // Written while the click still counts as a user gesture; the PNG comes once it is converted.
  const attempts = put.length === 1 ? [{ ...data, "image/png": pngOf(put[0]!) }, data] : [data];
  for (const item of attempts) {
    try {
      return await navigator.clipboard.write([new ClipboardItem(item)]);
    } catch {
      // Try with less: without the PNG, then text only.
    }
  }
  return navigator.clipboard.writeText(text);
}

/** On copying a selection in `within` that takes in images, puts them in the copied HTML. True when it did. */
export function copySelection(e: ClipboardEvent, within: Element): boolean {
  const sel = window.getSelection();
  if (!e.clipboardData || !sel || sel.isCollapsed || sel.rangeCount === 0 || !within.contains(sel.anchorNode))
    return false;
  const range = sel.getRangeAt(0);
  const marks = [...within.querySelectorAll("mark.token")].filter((m) => range.intersectsNode(m));
  if (!marks.some((m) => tokenImages.has(m))) return false;
  const root = document.createElement("div");
  root.append(range.cloneContents());
  if (
    inlineImages(
      root,
      marks.map((m) => tokenImages.get(m)),
    ).length === 0
  )
    return false;
  e.clipboardData.setData("text/plain", sel.toString());
  e.clipboardData.setData("text/html", copiedHtml(root));
  e.preventDefault();
  return true;
}

/** The tokens in HTML copied from the composer. */
export function htmlTokens(html: string): string[] {
  const marks = new DOMParser().parseFromString(html, "text/html").querySelectorAll<HTMLElement>("mark[data-token]");
  return [...marks].map((mark) => mark.dataset.token!);
}

/** The images of a message copied by `copyMessage`, from the HTML on the clipboard; undefined for other HTML. */
export function copiedImages(html: string): CopiedImage[] | undefined {
  if (!html.includes(COPIED_ATTR)) return undefined;
  const root = new DOMParser().parseFromString(html, "text/html").querySelector(`[${COPIED_ATTR}]`);
  if (!root) return undefined;
  return [...root.querySelectorAll<HTMLImageElement>("img[data-token]")].map((img) => ({
    token: img.dataset.token!,
    src: img.getAttribute("src") ?? "",
  }));
}
