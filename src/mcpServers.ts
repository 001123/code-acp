import type * as acp from "@agentclientprotocol/sdk";
import { Effect, Exit, Schema } from "effect";
import * as vscode from "vscode";
import { McpServerEntry } from "./settings";

const Entries = Schema.Record(Schema.String, Schema.Unknown);
const decodeEntries = Schema.decodeUnknownExit(Entries);
const decodeEntry = Schema.decodeUnknownExit(McpServerEntry);

const pairs = (record: Readonly<Record<string, string>> | undefined) =>
  Object.entries(record ?? {}).map(([name, value]) => ({ name, value }));

function toAcp(name: string, entry: McpServerEntry): acp.McpServer {
  if ("url" in entry) {
    return { type: entry.type, name, url: entry.url, headers: pairs(entry.headers) };
  }
  return { name, command: entry.command, args: [...(entry.args ?? [])], env: pairs(entry.env) };
}

/**
 * The servers from codeAcp.mcpServers to pass to a new or reopened session. Entries are decoded one by
 * one, unlike readSettings, so one bad entry does not drop the others. Invalid entries and transports
 * the agent does not support are skipped with a warning in the output channel.
 */
export const mcpServersFor = Effect.fn("mcpServersFor")(function* (
  capabilities: acp.McpCapabilities | undefined,
): Effect.fn.Return<Array<acp.McpServer>> {
  const raw = vscode.workspace.getConfiguration("codeAcp").get("mcpServers");
  const entries = decodeEntries(raw ?? {});
  if (Exit.isFailure(entries)) {
    yield* Effect.logWarning("[mcp] codeAcp.mcpServers must be an object of servers by name");
    return [];
  }
  const servers: Array<acp.McpServer> = [];
  for (const [name, value] of Object.entries(entries.value)) {
    const entry = decodeEntry(value);
    if (Exit.isFailure(entry)) {
      yield* Effect.logWarning(`[mcp] skipped "${name}": invalid server entry`);
      continue;
    }
    const type = entry.value.type ?? "stdio";
    if ((type === "http" || type === "sse") && !capabilities?.[type]) {
      yield* Effect.logWarning(`[mcp] skipped "${name}": the agent does not support ${type} servers`);
      continue;
    }
    servers.push(toAcp(name, entry.value));
  }
  return servers;
});
