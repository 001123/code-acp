import type { Attachment, PromptPart } from "../../chat/protocol";
import { attachmentKey, imageSrc } from "./attachments";
import type { TokenInfo } from "./editor";

/** What the composer of one tab holds. */
export interface Content {
  text: string;
  inline: Map<string, Attachment>;
  attachments: Attachment[];
}

/** The composer content a sent or queued message is made of. */
export function contentOf(parts: ReadonlyArray<PromptPart>): Content {
  const content: Content = { text: "", inline: new Map(), attachments: [] };
  for (const part of parts) {
    if (typeof part === "string") {
      content.text += part;
      continue;
    }
    const { token, ...attachment } = part;
    if (token) {
      content.text += token;
      content.inline.set(token, attachment);
    } else {
      content.attachments.push(attachment);
    }
  }
  return content;
}

/** `added` after `content`, its tokens renamed where `content` already uses them. */
export function appendContent(content: Content, added: Content): Content {
  let text = added.text;
  const inline = new Map(content.inline);
  for (const [token, attachment] of added.inline) {
    let name = token;
    for (let n = 2; inline.has(name); n++) name = `${token} (${n})`;
    if (name !== token) text = text.split(token).join(name);
    inline.set(name, attachment);
  }
  const lead = content.text.trim() ? `${content.text.trimEnd()}\n\n` : "";
  return { text: lead + text, inline, attachments: [...content.attachments, ...added.attachments] };
}

/** Tokens drawn as chips in the editor. */
export function tokenInfos(inline: Map<string, Attachment>): TokenInfo[] {
  return [...inline].map(([token, a]) => ({ token, image: imageSrc(a) !== undefined }));
}

/** Forgets the tokens no longer in the text. */
export function pruneTokens(tokens: Map<string, Attachment>, shown: ReadonlySet<string>): void {
  for (const token of tokens.keys()) if (!shown.has(token)) tokens.delete(token);
}

/** A free token for `a`, kept in `tokens`; undefined when the same file is already in the text (`shown`). */
export function addToken(tokens: Map<string, Attachment>, shown: ReadonlySet<string>, a: Attachment, sigil: string): string | undefined {
  pruneTokens(tokens, shown);
  const key = attachmentKey(a);
  if (key !== undefined && [...tokens.values()].some((x) => attachmentKey(x) === key)) return undefined;
  let token = `${sigil}${a.name}`;
  for (let n = 2; tokens.has(token); n++) token = `${sigil}${a.name} (${n})`;
  tokens.set(token, a);
  return token;
}
