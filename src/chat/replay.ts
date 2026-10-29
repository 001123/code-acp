import type * as acp from "@agentclientprotocol/sdk";
import type { PromptPart } from "./protocol";

// The patterns match `fileLinkTokens` in `src/ui/chat/transcript.ts`, which shows the same messages.

/** How Claude Code's ACP adapter writes a file it was sent. */
const FILE_LINK = /\[(@[^\]\n]+)\]\((file:\/\/[^)\s]+)\)/g;

/** The adapter's copy of an embedded file, which it appends after the prompt. */
const CONTEXT = /\n?<context ref="[^"]*">\n[\s\S]*?\n<\/context>/g;

/** The editor selection "include open file" sends: the last prompt block, before any context. */
const SELECTION = /Selection \([^\n]*:\d+-\d+\):\n[\s\S]*?(?=\n<context ref="|$)/;

/**
 * The composer parts of a replayed user message, so it can be edited or sent again: its images and file links become
 * inline attachments, named as the webview names them, and the context the adapter added is left out.
 */
export function replayedParts(blocks: ReadonlyArray<acp.ContentBlock>): PromptPart[] {
  const images = new Map<string, PromptPart>();
  let raw = "";
  for (const block of blocks) {
    if (block.type === "image") {
      const ext = /^image\/(\w+)/.exec(block.mimeType)?.[1]?.replace("jpeg", "jpg") ?? "png";
      const token = images.size === 0 ? `@image.${ext}` : `@image.${ext} (${images.size + 1})`;
      images.set(token, { kind: "data", name: token.slice(1), mimeType: block.mimeType, data: block.data, token });
      raw += token;
    } else if (block.type === "text") {
      raw += block.text;
    } else if (block.type === "resource_link") {
      raw += `[${block.name}](${block.uri})`;
    } else if (block.type === "resource") {
      raw += ("text" in block.resource ? block.resource.text : undefined) ?? block.resource.uri;
    }
  }
  const text = raw.replace(SELECTION, "").replace(CONTEXT, "").trimEnd();
  const parts: PromptPart[] = [];
  let from = 0;
  const pushText = (s: string) => {
    if (!s) return;
    const last = parts.at(-1);
    if (typeof last === "string") parts[parts.length - 1] = last + s;
    else parts.push(s);
  };
  // Image tokens, then file links, in the order they appear.
  const found: Array<{ at: number; end: number; part: PromptPart }> = [];
  for (const [token, part] of images) {
    const at = text.indexOf(token);
    if (at >= 0) found.push({ at, end: at + token.length, part });
  }
  for (const m of text.matchAll(FILE_LINK)) {
    const [link, token, uri] = m as unknown as [string, string, string];
    const name = token.slice(1);
    found.push({ at: m.index, end: m.index + link.length, part: { kind: "uri", uri, name, token } });
  }
  found.sort((a, b) => a.at - b.at);
  for (const { at, end, part } of found) {
    if (at < from) continue;
    pushText(text.slice(from, at));
    // The adapter joins prompt blocks without a separator; a file token needs spaces to stand apart.
    const isLink = typeof part !== "string" && part.kind === "uri";
    if (isLink && at > 0 && !/\s/.test(text[at - 1]!)) pushText(" ");
    parts.push(part);
    if (isLink && end < text.length && !/[\s.,;:!?)]/.test(text[end]!)) pushText(" ");
    from = end;
  }
  pushText(text.slice(from));
  return parts;
}
