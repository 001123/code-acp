import type * as acp from "@agentclientprotocol/sdk";

/** A string field of claude-agent-acp's `_meta.claudeCode` extension. */
function claudeMeta(u: acp.ToolCall | acp.ToolCallUpdate, key: "parentToolUseId" | "toolName"): string | undefined {
  const claude = u._meta?.["claudeCode"];
  const value = typeof claude === "object" && claude !== null ? (claude as Record<string, unknown>)[key] : undefined;
  return typeof value === "string" ? value : undefined;
}

/** The Agent/Task call that started the subagent making this call. */
export function parentToolUseId(u: acp.ToolCall | acp.ToolCallUpdate): string | undefined {
  return claudeMeta(u, "parentToolUseId");
}

/** Claude Code's tools that start a subagent; `Task` is the older name of `Agent`. */
const SUBAGENT_TOOLS = new Set(["Agent", "Task"]);

/** Whether this call starts a subagent. */
export function startsSubagent(u: acp.ToolCall | acp.ToolCallUpdate): boolean {
  const toolName = claudeMeta(u, "toolName");
  return toolName !== undefined && SUBAGENT_TOOLS.has(toolName);
}
