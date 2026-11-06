import type * as acp from "@agentclientprotocol/sdk";
import type { SentAttachment, TurnTrace } from "../../chat/protocol";
import type { Translate } from "../l10n";
import type { Token } from "./tokens";
import { parentToolUseId, startsSubagent } from "./toolMeta";

/** A localized line: a message key with its arguments, translated when rendered. */
export type Text = { key: Parameters<Translate>[0]; args?: unknown[] } | { raw: string };

export type Item =
  /** `tokens` stand for the images of replayed user messages, where they were in the text. */
  /** `turn` is set on replayed user messages the extension keeps to edit or send again. */
  | { kind: "assistant" | "user" | "thought"; id: number; text: string; tokens?: Token[]; turn?: number }
  /** `turn` is set for messages sent from this chat, not for replayed ones. */
  | { kind: "userMessage"; id: number; text: string; attachments: SentAttachment[]; turn?: number }
  | ToolItem
  | { kind: "plan"; id: number; entries: acp.PlanEntry[] }
  | {
      kind: "permission";
      id: number;
      requestId: number;
      toolCall: acp.ToolCallUpdate;
      options: acp.PermissionOption[];
      done: boolean;
    }
  | ElicitationItem
  | CompactionItem
  | { kind: "notice" | "error"; id: number; text: Text }
  /** The numbers of a finished turn; shown while codeAcp.tracing is on. */
  | { kind: "trace"; id: number; trace: TurnTrace };

interface ElicitationBase {
  kind: "elicitation";
  id: number;
  requestId: number;
  message: string;
  /** The tool call that asks, e.g. Claude Code's AskUserQuestion. */
  toolCallId?: string;
  /** The answer's action, once it was answered or dismissed. */
  outcome?: string;
}

/** A form the agent asks the user to fill in. */
export interface FormElicitationItem extends ElicitationBase {
  schema: acp.ElicitationSchema;
}

/** A link the agent asks the user to open. */
export interface UrlElicitationItem extends ElicitationBase {
  url: string;
  elicitationId: string;
  /** The agent said that what the link was opened for is done. */
  completed?: boolean;
}

export type ElicitationItem = FormElicitationItem | UrlElicitationItem;

/** The agent compacting the conversation's context; it stays where it started, and updates in place. */
export interface CompactionItem {
  kind: "compaction";
  id: number;
  compactionId: string;
  status: acp.CompactionStatus;
  summary: string;
  error?: string;
}

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
  /** The open permission requests and questions of that subagent. */
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
  | { type: "chunk"; kind: "assistant" | "user" | "thought"; text: string; image?: string; turn?: number }
  | { type: "toolCall"; update: acp.ToolCall | acp.ToolCallUpdate }
  | { type: "plan"; entries: acp.PlanEntry[] }
  | { type: "add"; item: DistributiveOmit<Item, "id"> }
  | { type: "permissionDone"; requestId: number }
  | { type: "elicitationDone"; requestId: number; action: string }
  | { type: "elicitationComplete"; elicitationId: string }
  | { type: "compaction"; update: acp.CompactionUpdate }
  | { type: "compactionChunk"; compactionId: string; text: string }
  /** The agent's process is gone: what it was compacting will never report back. */
  | { type: "agentStopped" }
  /** The turn ended: the next chunk starts a new block. */
  | { type: "endStream" }
  /** Drops the user message of `turn` and everything after it. */
  | { type: "rewind"; turn: number }
  /** Puts back the numbers of a replayed session's turns, each after its user message's reply. */
  | { type: "restoreTraces"; traces: ReadonlyArray<{ turn: number; trace: TurnTrace }> }
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

/** A permission request's raw input as shown on its card; nothing for an empty one, which some agents always send. */
export function permissionInput(toolCall: acp.ToolCallUpdate): string | undefined {
  const input = toolCall.rawInput;
  if (!input || (typeof input === "object" && Object.keys(input).length === 0)) return undefined;
  return clip(JSON.stringify(input, null, 2));
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

/** The open permission request or question of `item`, and the tool call it is about. */
export function openRequest(
  item: DistributiveOmit<Item, "id">,
): { requestId: number; toolCallId?: string; parentId?: string } | undefined {
  if (item.kind === "permission" && !item.done) {
    return {
      requestId: item.requestId,
      toolCallId: item.toolCall.toolCallId,
      parentId: parentToolUseId(item.toolCall),
    };
  }
  if (item.kind === "elicitation" && item.outcome === undefined) {
    return { requestId: item.requestId, toolCallId: item.toolCallId };
  }
  return undefined;
}

function findCompaction(state: Transcript, compactionId: string): CompactionItem | undefined {
  return state.items.find((i): i is CompactionItem => i.kind === "compaction" && i.compactionId === compactionId);
}

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
      const same = current && current.kind === action.kind && current.turn === action.turn ? current : undefined;
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
      return add({ kind: action.kind, text, tokens, turn: action.turn }, true);
    }
    case "toolCall": {
      const u = action.update;
      const merge = (i: ToolItem): ToolItem => ({
        ...i,
        ...(startsSubagent(u) ? { subagent: true } : {}),
        ...(u.title ? { title: u.title } : {}),
        ...(u.status ? { status: u.status } : {}),
        ...(u.content ? { content: clipContent(u.content) } : {}),
        ...(u.locations ? { locations: u.locations } : {}),
      });
      const isTool = (i: Item): i is ToolItem => i.kind === "tool";
      const parentId = parentToolUseId(u);
      const parent =
        parentId === undefined ? undefined : state.items.find((i) => isTool(i) && i.toolCallId === parentId);
      const holder = state.items.find((i) => isTool(i) && i.children?.some((c) => c.toolCallId === u.toolCallId));
      if (holder && isTool(holder)) {
        const children = holder.children!.map((c) => (c.toolCallId === u.toolCallId ? merge(c) : c));
        return { ...state, items: replace(holder.id, () => ({ ...holder, children })) };
      }
      const existing = state.items.find((i) => isTool(i) && i.toolCallId === u.toolCallId);
      if (parent && isTool(parent) && parent !== existing) {
        // A subagent's call goes under the call that started it, also when an earlier update did not say so.
        const child =
          existing && isTool(existing)
            ? merge(existing)
            : merge({ kind: "tool", id: state.nextId, toolCallId: u.toolCallId });
        const open = state.items.flatMap((i) => {
          const request = openRequest(i);
          return request && request.toolCallId === u.toolCallId ? [request.requestId] : [];
        });
        const waiting = [...(parent.waiting ?? []), ...open.filter((id) => !parent.waiting?.includes(id))];
        const items = state.items
          .filter((i) => i !== existing)
          .map((i) =>
            i === parent ? { ...parent, subagent: true, children: [...(parent.children ?? []), child], waiting } : i,
          );
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
      const request = openRequest(action.item);
      if (request?.toolCallId === undefined) return next;
      // A subagent's request also shows on the call that started the subagent.
      const { toolCallId, parentId, requestId } = request;
      const parent = next.items.find(
        (i) =>
          i.kind === "tool" &&
          (parentId === undefined ? i.children?.some((c) => c.toolCallId === toolCallId) : i.toolCallId === parentId),
      );
      if (!parent || parent.kind !== "tool") return next;
      return {
        ...next,
        items: next.items.map((i) =>
          i === parent ? { ...parent, waiting: [...(parent.waiting ?? []), requestId] } : i,
        ),
      };
    }
    case "permissionDone":
    case "elicitationDone":
      return {
        ...state,
        items: state.items.map((i): Item => {
          if (i.kind === "tool" && i.waiting?.includes(action.requestId)) {
            return { ...i, waiting: i.waiting.filter((id) => id !== action.requestId) };
          }
          if (i.kind === "permission" && i.requestId === action.requestId) return { ...i, done: true };
          if (i.kind === "elicitation" && i.requestId === action.requestId && action.type === "elicitationDone") {
            return { ...i, outcome: action.action };
          }
          return i;
        }),
      };
    case "elicitationComplete":
      return {
        ...state,
        items: state.items.map((i) =>
          i.kind === "elicitation" && "url" in i && i.elicitationId === action.elicitationId
            ? { ...i, completed: true }
            : i,
        ),
      };
    case "compaction": {
      const { compactionId, status, summary, error } = action.update;
      // Omitted: unchanged. Null: cleared.
      const patch = {
        status,
        ...(summary !== undefined ? { summary: clip((summary ?? []).map(contentText).join("")) } : {}),
        ...(error !== undefined ? { error: error ?? undefined } : {}),
      };
      const found = findCompaction(state, compactionId);
      return found
        ? { ...state, items: replace(found.id, () => ({ ...found, ...patch })) }
        : add({ kind: "compaction", compactionId, summary: "", ...patch });
    }
    case "compactionChunk": {
      const found = findCompaction(state, action.compactionId);
      return found
        ? { ...state, items: replace(found.id, () => ({ ...found, summary: clip(found.summary + action.text) })) }
        : add({
            kind: "compaction",
            compactionId: action.compactionId,
            status: "in_progress",
            summary: clip(action.text),
          });
    }
    case "agentStopped":
      return {
        ...state,
        items: state.items.map((i) =>
          i.kind === "compaction" && i.status === "in_progress" ? { ...i, status: "cancelled" } : i,
        ),
      };
    case "endStream":
      return { ...state, streaming: undefined };
    case "rewind": {
      const index = state.items.findIndex(
        (i) => (i.kind === "userMessage" || i.kind === "user") && i.turn === action.turn,
      );
      return index < 0 ? state : { ...state, items: state.items.slice(0, index), streaming: undefined };
    }
    case "restoreTraces": {
      const byTurn = new Map(action.traces.map(({ turn, trace }) => [turn, trace]));
      const items: Item[] = [];
      let nextId = state.nextId;
      let pending: TurnTrace | undefined;
      const flush = () => {
        if (pending) {
          items.push({ kind: "trace", id: nextId++, trace: pending });
        }
      };
      for (const item of state.items) {
        if (item.kind === "user" || item.kind === "userMessage") {
          flush();
          pending = item.turn === undefined ? undefined : byTurn.get(item.turn);
        }
        items.push(item);
      }
      flush();
      return { ...state, items, nextId, streaming: undefined };
    }
    case "reset":
      return EMPTY;
  }
}

/** The line a finished turn leaves in the transcript; none when it ended the way the user expects. */
/** A localized line as the user reads it. */
export function renderText(t: Translate, text: Text): string {
  return "raw" in text ? text.raw : t(text.key, ...(text.args ?? []));
}

/** The line saying how the agent's compaction went. */
export function compactionLabel(t: Translate, item: CompactionItem): string {
  return item.status === "in_progress"
    ? t("chat.compaction.inProgress")
    : item.status === "completed"
      ? t("chat.compaction.completed")
      : item.status === "failed"
        ? t("chat.compaction.failed")
        : item.status === "cancelled"
          ? t("chat.compaction.cancelled")
          : t("chat.compaction.other", item.status);
}

export function stopReasonText(stopReason: string): Text | undefined {
  switch (stopReason) {
    case "end_turn":
    case "cancelled":
      return undefined;
    case "max_tokens":
      return { key: "chat.stopReason.maxTokens" };
    case "max_turn_requests":
      return { key: "chat.stopReason.maxTurnRequests" };
    case "refusal":
      return { key: "chat.stopReason.refusal" };
    default:
      return { key: "chat.stopReason", args: [stopReason] };
  }
}

/** A session notice as a transcript item; other severities than `error` look the same. */
export function noticeItem(notice: acp.Notice): DistributiveOmit<Extract<Item, { kind: "notice" | "error" }>, "id"> {
  return {
    kind: notice.severity === "error" ? "error" : "notice",
    text: { raw: notice.description ? `${notice.title} — ${notice.description}` : notice.title },
  };
}

export function contentText(block: acp.ContentBlock | undefined): string {
  if (!block) return "";
  if (block.type === "text") return block.text;
  if (block.type === "resource_link") return `[${block.name}](${block.uri})`;
  if (block.type === "resource")
    return ("text" in block.resource ? block.resource.text : undefined) ?? block.resource.uri ?? "";
  return `[${block.type}]`;
}

/** How Claude Code's ACP adapter writes a file it was sent, which is what a replayed user message holds. */
const FILE_LINK = /\[(@[^\]\n]+)\]\((file:\/\/[^)\s]+)\)/g;

/** The adapter's copy of an embedded file, which it appends after the prompt. */
const CONTEXT = /\n?<context ref="[^"]*">\n[\s\S]*?\n<\/context>/g;

/** The editor selection older versions of "include open file" sent, still in older sessions: the last prompt block, before any context. */
const SELECTION = /Selection \([^\n]*:\d+-\d+\):\n[\s\S]*?(?=\n<context ref="|$)/;

/**
 * A replayed user message with its `[@name](file://…)` links turned into `@name` tokens, and without the context the
 * live message does not show either: embedded file contents and the open file's selection. The adapter joins prompt
 * blocks without a separator, so a token gets the spaces it needs to stand apart from the words around it.
 */
export function fileLinkTokens(replayed: string): { text: string; tokens: Token[] } {
  const tokens: Token[] = [];
  const text = replayed.replace(SELECTION, "").replace(CONTEXT, "").trimEnd();
  const out = text.replace(FILE_LINK, (link, token: string, uri: string, at: number) => {
    let path: string;
    try {
      path = decodeURIComponent(new URL(uri).pathname).replace(/^\/(?=[A-Za-z]:)/, "");
    } catch {
      return link;
    }
    tokens.push({ token, path });
    const before = at > 0 && !/\s/.test(text[at - 1]!) ? " " : "";
    const end = at + link.length;
    const after = end < text.length && !/[\s.,;:!?)]/.test(text[end]!) ? " " : "";
    return before + token + after;
  });
  return { text: out, tokens };
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
