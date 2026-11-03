import type { Translate } from "../l10n";
import { compactionLabel, fileLinkTokens, renderText, type Item, type ToolItem } from "./transcript";

export interface ConversationInfo {
  title: string;
  /** The agent's name. */
  agent?: string;
  /** When it was exported, as the reader should see it. */
  date: string;
}

const TOOL_MARK: Record<string, string> = { completed: "✓", failed: "✗", in_progress: "…", pending: "…" };

/** One line of text that must read as written, not as Markdown or HTML. */
const inline = (text: string) =>
  text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\\`*_<>[\]]/g, "\\$&");

const quote = (text: string) => text.trim().replace(/^/gm, "> ");

const collapsed = (summary: string, body: string) => `<details>\n<summary>${inline(summary)}</summary>\n\n${body.trim()}\n\n</details>`;

/** A tool call as a line of a list, the calls of its subagent below it; what they output is left out. */
function toolLines(t: Translate, tool: ToolItem, depth = 0): string[] {
  const mark = (tool.status && TOOL_MARK[tool.status]) ?? "•";
  const line = `${"  ".repeat(depth)}- ${mark} ${inline(tool.title ?? "") || t("export.tool")}`;
  return [line, ...(tool.children ?? []).flatMap((child) => toolLines(t, child, depth + 1))];
}

/** What `item` adds to its speaker's part; nothing for what only mattered at the time (permissions, turn numbers). */
function itemBlock(t: Translate, item: Item): string | undefined {
  switch (item.kind) {
    case "assistant":
      return item.text.trim();
    case "user":
      return fileLinkTokens(item.text).text.trim();
    case "userMessage": {
      const files = item.attachments.filter((a) => !a.token && a.name).map((a) => inline(a.name!));
      return [item.text.trim(), ...(files.length > 0 ? [`${t("export.attachments")}: ${files.join(", ")}`] : [])].filter(Boolean).join("\n\n");
    }
    case "thought":
      return item.text.trim() && collapsed(t("chat.thought"), item.text);
    case "tool":
      return toolLines(t, item).join("\n");
    case "plan":
      return [`**${t("chat.plan")}**`, "", ...item.entries.map((e) => `- [${e.status === "completed" ? "x" : " "}] ${inline(e.content)}`)].join("\n");
    case "elicitation":
      return quote(item.message);
    case "compaction":
      return item.summary.trim() ? collapsed(compactionLabel(t, item), item.summary) : `_${inline(compactionLabel(t, item))}_`;
    case "notice":
      return `_${inline(renderText(t, item.text))}_`;
    case "error":
      return quote(renderText(t, item.text));
    case "permission":
    case "trace":
      return undefined;
  }
}

/** The conversation as a Markdown document; empty when nobody has said anything yet. */
export function conversationMarkdown(t: Translate, items: readonly Item[], info: ConversationInfo): string {
  if (!items.some((item) => item.kind === "assistant" || item.kind === "user" || item.kind === "userMessage")) return "";
  const blocks = [`# ${inline(info.title)}`, [...(info.agent ? [inline(info.agent)] : []), inline(info.date)].join(" · ")];
  let speaker: "user" | "assistant" | undefined;
  let afterTool = false;
  for (const item of items) {
    const block = itemBlock(t, item);
    if (!block) continue;
    const said = item.kind === "user" || item.kind === "userMessage" ? "user" : item.kind === "notice" || item.kind === "error" ? speaker : "assistant";
    if (said && said !== speaker) {
      speaker = said;
      afterTool = false;
      blocks.push(`## ${t(said === "user" ? "export.user" : "export.assistant")}`);
    }
    // A run of tool calls is one list.
    if (item.kind === "tool" && afterTool) blocks[blocks.length - 1] += `\n${block}`;
    else blocks.push(block);
    afterTool = item.kind === "tool";
  }
  return `${blocks.join("\n\n")}\n`;
}
