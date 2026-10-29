import type * as acp from "@agentclientprotocol/sdk";
import type { SentAttachment } from "../../chat/protocol";
import type { Translate } from "../l10n";
import type { Token } from "./tokens";

/** A localized line: a message key with its arguments, translated when rendered. */
export type Text = { key: Parameters<Translate>[0]; args?: unknown[] } | { raw: string };

export type Item =
  /** `tokens` stand for the images of replayed user messages, where they were in the text. */
  | { kind: "assistant" | "user" | "thought"; id: number; text: string; tokens?: Token[] }
  /** `turn` is set for messages sent from this chat, not for replayed ones. */
  | { kind: "userMessage"; id: number; text: string; attachments: SentAttachment[]; turn?: number }
  | ToolItem
  | { kind: "plan"; id: number; entries: acp.PlanEntry[] }
  | { kind: "permission"; id: number; requestId: number; toolCall: acp.ToolCallUpdate; options: acp.PermissionOption[]; done: boolean }
  | { kind: "notice" | "error"; id: number; text: Text };

export interface ToolItem {
  kind: "tool";
  id: number;
  toolCallId: string;
  title?: string;
  status?: acp.ToolCallStatus;
  content?: acp.ToolCallContent[];
  locations?: acp.ToolCallLocation[];
  /** The call starts a subagent. */
  subagent?: boolean;
  /** The tool calls of the subagent that this call started. */
  children?: ToolItem[];
  /** The open permission requests of that subagent. */
  waiting?: number[];
}

export interface Transcript {
  items: Item[];
  nextId: number;
  /** Item receiving streamed chunks; cleared when another kind of item arrives. */
  streaming?: number;
  planId?: number;
}

export type Action =
  | { type: "chunk"; kind: "assistant" | "user" | "thought"; text: string; image?: string }
  | { type: "toolCall"; update: acp.ToolCall | acp.ToolCallUpdate }
  | { type: "plan"; entries: acp.PlanEntry[] }
  | { type: "add"; item: DistributiveOmit<Item, "id"> }
  | { type: "permissionDone"; requestId: number }
  /** The turn ended: the next chunk starts a new block. */
  | { type: "endStream" }
  /** Drops the user message of `turn` and everything after it. */
  | { type: "rewind"; turn: number }
  | { type: "reset" };

export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export const EMPTY: Transcript = { items: [], nextId: 1 };

/**
 * Characters kept of one tool output. Agents send whole files here, and every tab keeps its transcript for as
 * long as the view lives; the view shows the start and reveals the rest on demand.
 */
const MAX_TOOL_TEXT = 500_000;
/** Characters kept of one diff side; the full diff opens in an editor. */
const MAX_DIFF_TEXT = 20_000;

export function clip(text: string, max = MAX_TOOL_TEXT): string {
  return text.length > max ? `${text.slice(0, max)}\n…` : text;
}

/** Tool call content as the transcript keeps it: long text clipped, binary data dropped (only its kind is shown). */
export function clipContent(content: acp.ToolCallContent[] | null | undefined): acp.ToolCallContent[] | undefined {
  return content?.map((item): acp.ToolCallContent => {
    if (item.type === "diff") {
      return {
        ...item,
        oldText: item.oldText == null ? item.oldText : clip(item.oldText, MAX_DIFF_TEXT),
        newText: clip(item.newText, MAX_DIFF_TEXT),
      };
    }
    if (item.type !== "content") return item;
    const block = item.content;
    switch (block.type) {
      case "text":
        return { ...item, content: { ...block, text: clip(block.text) } };
      case "image":
      case "audio":
        return { ...item, content: { ...block, data: "" } };
      case "resource":
        return "text" in block.resource
          ? { ...item, content: { ...block, resource: { ...block.resource, text: clip(block.resource.text) } } }
          : { ...item, content: { ...block, resource: { ...block.resource, blob: "" } } };
      default:
        return item;
    }
  });
}

/** A string field of claude-agent-acp's `_meta.claudeCode` extension. */
function claudeMeta(u: acp.ToolCall | acp.ToolCallUpdate, key: "parentToolUseId" | "toolName"): string | undefined {
  const claude = u._meta?.["claudeCode"];
  const value = typeof claude === "object" && claude !== null ? (claude as Record<string, unknown>)[key] : undefined;
  return typeof value === "string" ? value : undefined;
}

/** The Agent/Task call that started the subagent making this call. */
function parentToolUseId(u: acp.ToolCall | acp.ToolCallUpdate): string | undefined {
  return claudeMeta(u, "parentToolUseId");
}

/** Claude Code's tools that start a subagent; `Task` is the older name of `Agent`. */
const SUBAGENT_TOOLS = new Set(["Agent", "Task"]);

export function transcript(state: Transcript, action: Action): Transcript {
  const add = (item: DistributiveOmit<Item, "id">, streaming?: boolean): Transcript => ({
    ...state,
    items: [...state.items, { ...item, id: state.nextId } as Item],
    nextId: state.nextId + 1,
    streaming: streaming ? state.nextId : undefined,
  });
  const replace = (id: number, f: (item: Item) => Item): Item[] => state.items.map((i) => (i.id === id ? f(i) : i));

  switch (action.type) {
    case "chunk": {
      const current = state.items.find((i) => i.id === state.streaming);
      const same = current && current.kind === action.kind ? current : undefined;
      let text = action.text;
      let tokens = same?.tokens;
      if (action.image) {
        // An image goes inline as a token at its place in the text, named like a pasted one.
        const ext = /^data:image\/(\w+)/.exec(action.image)?.[1]?.replace("jpeg", "jpg") ?? "png";
        const n = (tokens?.length ?? 0) + 1;
        const token = n === 1 ? `@image.${ext}` : `@image.${ext} (${n})`;
        // The text runs around it keep the spaces the composer put there.
        text += token;
        tokens = [...(tokens ?? []), { token, src: action.image }];
      }
      if (same) {
        return { ...state, items: replace(same.id, () => ({ ...same, text: same.text + text, tokens })) };
      }
      return add({ kind: action.kind, text, tokens }, true);
    }
    case "toolCall": {
      const u = action.update;
      const toolName = claudeMeta(u, "toolName");
      const merge = (i: ToolItem): ToolItem => ({
        ...i,
        ...(toolName !== undefined && SUBAGENT_TOOLS.has(toolName) ? { subagent: true } : {}),
        ...(u.title ? { title: u.title } : {}),
        ...(u.status ? { status: u.status } : {}),
        ...(u.content ? { content: clipContent(u.content) } : {}),
        ...(u.locations ? { locations: u.locations } : {}),
      });
      const isTool = (i: Item): i is ToolItem => i.kind === "tool";
      const parentId = parentToolUseId(u);
      const parent = parentId === undefined ? undefined : state.items.find((i) => isTool(i) && i.toolCallId === parentId);
      const holder = state.items.find((i) => isTool(i) && i.children?.some((c) => c.toolCallId === u.toolCallId));
      if (holder && isTool(holder)) {
        const children = holder.children!.map((c) => (c.toolCallId === u.toolCallId ? merge(c) : c));
        return { ...state, items: replace(holder.id, () => ({ ...holder, children })) };
      }
      const existing = state.items.find((i) => isTool(i) && i.toolCallId === u.toolCallId);
      if (parent && isTool(parent) && parent !== existing) {
        // A subagent's call goes under the call that started it, also when an earlier update did not say so.
        const child = existing && isTool(existing)
          ? merge(existing)
          : merge({ kind: "tool", id: state.nextId, toolCallId: u.toolCallId });
        const open = state.items.flatMap((i) =>
          i.kind === "permission" && !i.done && i.toolCall.toolCallId === u.toolCallId ? [i.requestId] : [],
        );
        const waiting = [...(parent.waiting ?? []), ...open.filter((id) => !parent.waiting?.includes(id))];
        const items = state.items
          .filter((i) => i !== existing)
          .map((i) => (i === parent ? { ...parent, subagent: true, children: [...(parent.children ?? []), child], waiting } : i));
        return { ...state, items, nextId: existing ? state.nextId : state.nextId + 1 };
      }
      if (!existing) {
        return add(merge({ kind: "tool", id: state.nextId, toolCallId: u.toolCallId }));
      }
      return { ...state, items: replace(existing.id, (i) => merge(i as ToolItem)) };
    }
    case "plan":
      if (state.planId !== undefined && state.items.some((i) => i.id === state.planId)) {
        return { ...state, items: replace(state.planId, (i) => ({ ...i, entries: action.entries })) };
      }
      return { ...add({ kind: "plan", entries: action.entries }), planId: state.nextId };
    case "add": {
      const next = add(action.item);
      if (action.item.kind !== "permission") return next;
      // A subagent's request also shows on the call that started the subagent.
      const { toolCall, requestId } = action.item;
      const parentId = parentToolUseId(toolCall);
      const parent = next.items.find(
        (i) =>
          i.kind === "tool" &&
          (parentId === undefined ? i.children?.some((c) => c.toolCallId === toolCall.toolCallId) : i.toolCallId === parentId),
      );
      if (!parent || parent.kind !== "tool") return next;
      return {
        ...next,
        items: next.items.map((i) => (i === parent ? { ...parent, waiting: [...(parent.waiting ?? []), requestId] } : i)),
      };
    }
    case "permissionDone":
      return {
        ...state,
        items: state.items.map((i) =>
          i.kind === "permission" && i.requestId === action.requestId
            ? { ...i, done: true }
            : i.kind === "tool" && i.waiting?.includes(action.requestId)
              ? { ...i, waiting: i.waiting.filter((id) => id !== action.requestId) }
              : i,
        ),
      };
    case "endStream":
      return { ...state, streaming: undefined };
    case "rewind": {
      const index = state.items.findIndex((i) => i.kind === "userMessage" && i.turn === action.turn);
      return index < 0 ? state : { ...state, items: state.items.slice(0, index), streaming: undefined };
    }
    case "reset":
      return EMPTY;
  }
}

export function contentText(block: acp.ContentBlock | undefined): string {
  if (!block) return "";
  if (block.type === "text") return block.text;
  if (block.type === "resource_link") return `[${block.name}](${block.uri})`;
  if (block.type === "resource") return ("text" in block.resource ? block.resource.text : undefined) ?? block.resource.uri ?? "";
  return `[${block.type}]`;
}

export type ActivityItem = { kind: "thought"; id: number; text: string } | ToolItem;

/** Groups each run of consecutive thoughts and tool calls into one entry. */
export function groupActivity(items: Item[]): (Item | ActivityItem[])[] {
  const out: (Item | ActivityItem[])[] = [];
  for (const item of items) {
    if (item.kind !== "thought" && item.kind !== "tool") {
      out.push(item);
      continue;
    }
    const activity = item as ActivityItem;
    const last = out[out.length - 1];
    if (Array.isArray(last)) last.push(activity);
    else out.push([activity]);
  }
  return out;
}
