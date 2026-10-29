import type * as acp from "@agentclientprotocol/sdk";
import { createContext, Fragment, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type ClipboardEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { Attachment, ChangesMessage, Draft, FromWebview as ChatMessage, PromptPart, SentAttachment, TabInfo, TerminalSnapshot } from "../chatViewProvider";
import type { FileSuggestion, SkillSuggestion } from "../completions";
import type { TerminalSuggestion } from "../terminalContext";
import { Icon } from "./icon";
import { Lightbox } from "./lightbox";
import { diffLines, hunks } from "./lineDiff";
import { MarkdownView, type FileRef } from "./markdown";
import { useL10n, type Translate } from "./l10n";
import { mount } from "./mount";
import { poster, useMessages } from "./vscode";
import arrowUpIcon from "@tabler/icons/outline/arrow-up.svg";
import paperclipIcon from "@tabler/icons/outline/paperclip.svg";
import stopIcon from "@tabler/icons/filled/player-stop.svg";
import adjustmentsIcon from "@tabler/icons/outline/adjustments.svg";
import boltIcon from "@tabler/icons/outline/bolt.svg";
import brainIcon from "@tabler/icons/outline/brain.svg";
import cpuIcon from "@tabler/icons/outline/cpu.svg";
import robotIcon from "@tabler/icons/outline/robot.svg";
import shieldIcon from "@tabler/icons/outline/shield-half.svg";
import xIcon from "@tabler/icons/outline/x.svg";
import plusIcon from "@tabler/icons/outline/plus.svg";
import pinIcon from "@tabler/icons/outline/pin.svg";
import pinFilledIcon from "@tabler/icons/filled/pin.svg";
import circleCheckIcon from "@tabler/icons/outline/circle-check.svg";
import circleDashedIcon from "@tabler/icons/outline/circle-dashed.svg";
import circleXIcon from "@tabler/icons/outline/circle-x.svg";
import loaderIcon from "@tabler/icons/outline/loader-2.svg";
import usersIcon from "@tabler/icons/outline/users.svg";
import eyeIcon from "@tabler/icons/outline/eye.svg";
import eyeOffIcon from "@tabler/icons/outline/eye-off.svg";
import undoIcon from "@tabler/icons/outline/arrow-back-up.svg";
import checkIcon from "@tabler/icons/outline/check.svg";
import diffIcon from "@tabler/icons/outline/file-diff.svg";
import restoreIcon from "@tabler/icons/outline/restore.svg";

const post = poster<ChatMessage>();
const openFile = (ref: FileRef) => post({ type: "openFile", ...ref });

const MAX_DATA_BYTES = 20 * 1024 * 1024;

interface Preview {
  src: string;
  name: string;
  /** Takes the drawn-on copy of a composer image; without it, the copy is attached as a new image. */
  replace?: (a: Attachment) => void;
}
/** Opens an image in the lightbox; provided by the app. */
const OpenPreview = createContext<(preview: Preview) => void>(() => {});

/** An image token under the pointer: `rect` is the box to place the thumbnail next to. */
interface Hover {
  src: string;
  rect: DOMRect;
}
/** Shows (or, with undefined, hides) the hover thumbnail; provided by the app. */
const HoverPreview = createContext<(hover: Hover | undefined) => void>(() => {});

/** The shown tab, for transcript entries that act on it. */
interface ShownTab {
  id?: number;
  busy: boolean;
  /** Turns whose user message can restore the files the agent changed from then on. */
  checkpoints: ReadonlySet<number>;
}
const ShownTab = createContext<ShownTab>({ busy: false, checkpoints: new Set() });

/** The shown tab's agent terminals by id; their own context, so output only re-renders the terminal views. */
const Terminals = createContext<Readonly<Record<string, TerminalSnapshot>>>({});

const HOVER_WIDTH = 240;
const HOVER_HEIGHT = 180;
const HOVER_GAP = 6;

/** Thumbnail floating above the hovered token, or below it when there is no room above. */
function HoverThumb({ hover }: { hover: Hover }) {
  const { rect } = hover;
  const left = Math.max(HOVER_GAP, Math.min(rect.left, window.innerWidth - HOVER_WIDTH - HOVER_GAP));
  const above = rect.top >= HOVER_HEIGHT + 2 * HOVER_GAP;
  const style = above ? { left, bottom: window.innerHeight - rect.top + HOVER_GAP } : { left, top: rect.bottom + HOVER_GAP };
  return (
    <div className="hover-thumb" style={style}>
      <img src={hover.src} alt="" />
    </div>
  );
}

/** A localized line: a message key with its arguments, translated when rendered. */
type Text = { key: Parameters<Translate>[0]; args?: unknown[] } | { raw: string };

type Item =
  /** `tokens` stand for the images of replayed user messages, where they were in the text. */
  | { kind: "assistant" | "user" | "thought"; id: number; text: string; tokens?: Token[] }
  /** `turn` is set for messages sent from this chat, not for replayed ones. */
  | { kind: "userMessage"; id: number; text: string; attachments: SentAttachment[]; turn?: number }
  | ToolItem
  | { kind: "plan"; id: number; entries: acp.PlanEntry[] }
  | { kind: "permission"; id: number; requestId: number; toolCall: acp.ToolCallUpdate; options: acp.PermissionOption[]; done: boolean }
  | { kind: "notice" | "error"; id: number; text: Text };

interface ToolItem {
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

interface Transcript {
  items: Item[];
  nextId: number;
  /** Item receiving streamed chunks; cleared when another kind of item arrives. */
  streaming?: number;
  planId?: number;
}

type Action =
  | { type: "chunk"; kind: "assistant" | "user" | "thought"; text: string; image?: string }
  | { type: "toolCall"; update: acp.ToolCall | acp.ToolCallUpdate }
  | { type: "plan"; entries: acp.PlanEntry[] }
  | { type: "add"; item: DistributiveOmit<Item, "id"> }
  | { type: "permissionDone"; requestId: number }
  /** The turn ended: the next chunk starts a new block. */
  | { type: "endStream" }
  | { type: "reset" };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

const EMPTY: Transcript = { items: [], nextId: 1 };

/**
 * Characters kept of one tool output or diff side. Agents send whole files here, and every tab keeps its
 * transcript for as long as the view lives.
 */
const MAX_TOOL_TEXT = 20_000;

function clip(text: string): string {
  return text.length > MAX_TOOL_TEXT ? `${text.slice(0, MAX_TOOL_TEXT)}\n…` : text;
}

/** Tool call content as the transcript keeps it: long text clipped, binary data dropped (only its kind is shown). */
function clipContent(content: acp.ToolCallContent[] | null | undefined): acp.ToolCallContent[] | undefined {
  return content?.map((item): acp.ToolCallContent => {
    if (item.type === "diff") {
      return { ...item, oldText: item.oldText == null ? item.oldText : clip(item.oldText), newText: clip(item.newText) };
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

function transcript(state: Transcript, action: Action): Transcript {
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
    case "reset":
      return EMPTY;
  }
}

function contentText(block: acp.ContentBlock | undefined): string {
  if (!block) return "";
  if (block.type === "text") return block.text;
  if (block.type === "resource_link") return `[${block.name}](${block.uri})`;
  if (block.type === "resource") return ("text" in block.resource ? block.resource.text : undefined) ?? block.resource.uri ?? "";
  return `[${block.type}]`;
}

/** Escape sequences (colors, cursor moves, titles) the commands print; the chat shows plain text. */
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

function plainOutput(text: string): string {
  // A bare carriage return redraws the line (progress bars): keep what was drawn last.
  return text.replace(ANSI, "").replace(/[^\n]*\r(?!\n)/g, "");
}

/** A command the agent runs in a client terminal, with its output so far. */
function TerminalView({ terminalId }: { terminalId: string }) {
  const { t } = useL10n();
  const tab = useContext(ShownTab);
  const terminal = useContext(Terminals)[terminalId];
  if (!terminal) return <div className="muted">{t("terminal.running")}</div>;
  const exit = terminal.exitStatus;
  const state = !exit
    ? t("terminal.running")
    : exit.signal
      ? t("terminal.signal", exit.signal)
      : t("terminal.exitCode", exit.exitCode ?? "?");
  return (
    <div className="terminal" data-running={!exit || undefined} data-failed={(exit && exit.exitCode !== 0) || undefined}>
      <div className="terminal-header">
        <code className="terminal-command">$ {terminal.command}</code>
        <span className="terminal-state">{state}</span>
        {!exit && tab.id !== undefined && (
          <button
            className="icon-btn small"
            title={t("terminal.kill")}
            aria-label={t("terminal.kill")}
            onClick={() => post({ type: "killTerminal", tab: tab.id!, terminalId })}
          >
            <Icon svg={stopIcon} />
          </button>
        )}
      </div>
      {terminal.output && (
        <pre className="tool-output terminal-output" ref={(el) => {
            // Follows the end of the output, like a terminal.
            if (el) el.scrollTop = el.scrollHeight;
          }}>
          {terminal.truncated && <span className="muted">{t("terminal.truncated")}…{"\n"}</span>}
          {plainOutput(terminal.output)}
        </pre>
      )}
    </div>
  );
}

/** A file change from a tool call: the changed lines with some context, and a button for the full diff. */
function DiffView({ diff }: { diff: Extract<acp.ToolCallContent, { type: "diff" }> }) {
  const { t } = useL10n();
  const tab = useContext(ShownTab);
  const parts = hunks(diffLines(diff.oldText, diff.newText));
  return (
    <div className="diff">
      <div className="diff-header">
        <a className="diff-path" href="#" title={diff.path} onClick={(e) => (e.preventDefault(), openFile({ path: diff.path }))}>
          {diff.path.split(/[\\/]/).pop()}
        </a>
        {tab.id !== undefined && (
          <button
            className="icon-btn small"
            title={t("chat.openDiff")}
            aria-label={t("chat.openDiff")}
            onClick={() => post({ type: "openDiff", tab: tab.id!, path: diff.path, oldText: diff.oldText, newText: diff.newText })}
          >
            <Icon svg={diffIcon} />
          </button>
        )}
      </div>
      <pre className="diff-lines">
        {parts.map((hunk, i) => (
          <Fragment key={i}>
            {i > 0 && <span className="diff-gap">⋯{"\n"}</span>}
            {hunk.lines.map((l, j) => (
              <span key={j} className={`diff-${l.type}`}>
                {l.type === "add" ? "+" : l.type === "del" ? "-" : " "} {l.text}
                {"\n"}
              </span>
            ))}
          </Fragment>
        ))}
      </pre>
    </div>
  );
}

function ToolContent({ content }: { content?: acp.ToolCallContent[] | null }) {
  return (
    <>
      {(content ?? []).map((item, i) =>
        item.type === "diff" ? (
          <DiffView key={i} diff={item} />
        ) : item.type === "content" ? (
          <pre key={i} className="tool-output">
            {contentText(item.content)}
          </pre>
        ) : item.type === "terminal" ? (
          <TerminalView key={i} terminalId={item.terminalId} />
        ) : null,
      )}
    </>
  );
}

/** The files a tool call works on; each opens at its line. */
function Locations({ locations }: { locations?: acp.ToolCallLocation[] }) {
  if (!locations?.length) return null;
  return (
    <div className="tool-locations">
      {locations.map((l, i) => {
        const name = `${l.path.split(/[\\/]/).pop()}${l.line ? `:${l.line}` : ""}`;
        return (
          <a key={i} href="#" title={l.path} onClick={(e) => (e.preventDefault(), openFile({ path: l.path, line: l.line ?? undefined }))}>
            {name}
          </a>
        );
      })}
    </div>
  );
}

/** On a user message whose turn changed files: puts them back as they were before it. */
function RestoreButton({ turn }: { turn?: number }) {
  const { t } = useL10n();
  const tab = useContext(ShownTab);
  if (turn === undefined || tab.id === undefined || !tab.checkpoints.has(turn)) return null;
  return (
    <button
      className="restore secondary"
      title={t("changes.restoreTitle")}
      disabled={tab.busy}
      onClick={() => post({ type: "restoreCheckpoint", tab: tab.id!, turn })}
    >
      <Icon svg={restoreIcon} />
      {t("changes.restore")}
    </button>
  );
}

/** The files the agent changed that are not reviewed yet: open the diff, keep or undo each, or all. */
function ChangesBar({ tab, changes }: { tab: number; changes: ChangesMessage | undefined }) {
  const { t } = useL10n();
  const files = changes?.files ?? [];
  if (files.length === 0) return null;
  return (
    <details id="changes">
      <summary>
        <span className="changes-count">{files.length === 1 ? t("changes.countOne") : t("changes.count", files.length)}</span>
        <span className="spacer" />
        <button
          className="secondary"
          onClick={(e) => (e.preventDefault(), post({ type: "undoChanges", tab }))}
        >
          {t("changes.undoAll")}
        </button>
        <button onClick={(e) => (e.preventDefault(), post({ type: "keepChanges", tab }))}>{t("changes.keepAll")}</button>
      </summary>
      <div className="changes-list">
        {files.map((f) => (
          <div key={f.path} className="changes-file">
            <a href="#" title={f.path} onClick={(e) => (e.preventDefault(), post({ type: "openDiff", tab, path: f.path }))}>
              {f.name}
            </a>
            {(f.created || f.deleted || f.binary) && (
              <span className="changes-new">
                {[f.created && t("changes.created"), f.deleted && t("changes.deleted"), f.binary && t("changes.binary")]
                  .filter(Boolean)
                  .join(", ")}
              </span>
            )}
            {!f.binary && (
              <span className="changes-stats">
                <span className="added">+{f.added}</span> <span className="removed">−{f.removed}</span>
              </span>
            )}
            <span className="spacer" />
            <button className="icon-btn small" title={t("chat.openDiff")} aria-label={t("chat.openDiff")} onClick={() => post({ type: "openDiff", tab, path: f.path })}>
              <Icon svg={diffIcon} />
            </button>
            <button className="icon-btn small" title={t("changes.undo")} aria-label={t("changes.undo")} onClick={() => post({ type: "undoChanges", tab, path: f.path })}>
              <Icon svg={undoIcon} />
            </button>
            <button className="icon-btn small" title={t("changes.keep")} aria-label={t("changes.keep")} onClick={() => post({ type: "keepChanges", tab, path: f.path })}>
              <Icon svg={checkIcon} />
            </button>
          </div>
        ))}
      </div>
    </details>
  );
}

const TOOL_ICON: Record<string, string> = {
  pending: circleDashedIcon,
  in_progress: loaderIcon,
  completed: circleCheckIcon,
  failed: circleXIcon,
};
const PLAN_MARK: Record<string, string> = { pending: "☐", in_progress: "◐", completed: "☑" };

function render(t: Translate, text: Text): string {
  return "raw" in text ? text.raw : t(text.key, ...(text.args ?? []));
}

type ActivityItem = { kind: "thought"; id: number; text: string } | ToolItem;

/** Groups each run of consecutive thoughts and tool calls into one entry. */
function groupActivity(items: Item[]): (Item | ActivityItem[])[] {
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

/** Silence after which the transcript says the agent is still on it. */
const WAITING_AFTER_MS = 3000;

/** "8s", "1m 05s". */
function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}

/** The current time, re-rendering every second while `ticking`. */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}

/** A run of thoughts and tool calls, collapsed under one "Thinking" summary. */
const ActivityView = memo(
  function ActivityView({ items }: { items: ActivityItem[] }) {
    const { t } = useL10n();
    const tools = items.filter((i) => i.kind === "tool");
    if (tools.length === 0 && items.length === 1) return <ItemView item={items[0]!} />;
    const running = tools.some((i) => i.status === "pending" || i.status === "in_progress");
    const failed = tools.filter((i) => i.status === "failed").length;
    const waiting = tools.some((i) => i.waiting && i.waiting.length > 0);
    const subagents = tools.filter((i) => i.subagent).length;
    return (
      <details className="activity" data-running={running || undefined}>
        <summary>
          {t("chat.thought")}
          {tools.length > 0 && <span className="activity-count"> · {t("chat.toolCount", tools.length)}</span>}
          {subagents > 0 && (
            <span className="activity-subagents" title={t("chat.subagentCount", subagents)}>
              {" · "}
              <Icon svg={usersIcon} /> {subagents}
            </span>
          )}
          {failed > 0 && <span className="activity-failed"> · {t("chat.toolFailed", failed)}</span>}
          {waiting && <span className="tool-waiting"> · {t("chat.needsInput")}</span>}
        </summary>
        <div className="activity-body">
          {items.map((item) =>
            item.kind === "thought" ? (
              <MarkdownView key={item.id} className="thought text md" text={item.text} onOpenFile={openFile} />
            ) : (
              <ItemView key={item.id} item={item} />
            ),
          )}
        </div>
      </details>
    );
  },
  // groupActivity builds a new array per render; the items in it keep their identity until they change.
  (prev, next) => prev.items.length === next.items.length && prev.items.every((item, i) => item === next.items[i]),
);

/** Image chips for a sent or replayed user message; images open in the lightbox. */
function SentAttachments({ attachments }: { attachments: SentAttachment[] }) {
  const { t } = useL10n();
  const open = useContext(OpenPreview);
  if (attachments.length === 0) return null;
  return (
    <div className="msg-attachments">
      {attachments.map(({ name, src }, i) => (
        <span key={i} className="chip" title={name}>
          {src && <img className="chip-preview" src={src} title={t("chat.previewImage")} onClick={() => open({ src, name })} />}
          {name && <span>{name}</span>}
        </span>
      ))}
    </div>
  );
}

/** One transcript entry; memoized so a streamed chunk only re-renders the entry it extends. */
const ItemView = memo(function ItemView({ item }: { item: Item }) {
  const { t } = useL10n();
  switch (item.kind) {
    case "assistant":
      return <MarkdownView className="msg assistant md" text={item.text} onOpenFile={openFile} />;
    case "user":
      return (
        <div className="msg user">
          <Tokens text={item.text} tokens={item.tokens ?? []} />
        </div>
      );
    case "thought":
      return (
        <details className="thought">
          <summary>{t("chat.thought")}</summary>
          <MarkdownView className="text md" text={item.text} onOpenFile={openFile} />
        </details>
      );
    case "userMessage":
      return (
        <div className="msg user">
          <Tokens text={item.text} tokens={item.attachments.flatMap(({ token, src }) => (token ? [{ token, src }] : []))} />
          <SentAttachments attachments={item.attachments.filter((a) => !a.token)} />
          <RestoreButton turn={item.turn} />
        </div>
      );
    case "tool": {
      const children = item.children ?? [];
      const failed = children.filter((c) => c.status === "failed").length;
      return (
        <details className="tool" data-status={item.status}>
          <summary>
            <span className="tool-status">{item.status && TOOL_ICON[item.status] && <Icon svg={TOOL_ICON[item.status]} />}</span>
            {item.subagent && (
              <span className="tool-subagent" title={t("chat.subagent")}>
                <Icon svg={usersIcon} />
              </span>
            )}
            <span className="tool-title">{item.title}</span>
            {children.length > 0 && <span className="activity-count"> · {t("chat.toolCount", children.length)}</span>}
            {failed > 0 && <span className="activity-failed"> · {t("chat.toolFailed", failed)}</span>}
            {item.waiting && item.waiting.length > 0 && <span className="tool-waiting"> · {t("chat.needsInput")}</span>}
          </summary>
          <div className="tool-body">
            <Locations locations={item.locations} />
            {children.length > 0 && (
              <div className="subagent-tools">
                {children.map((child) => (
                  <ItemView key={child.id} item={child} />
                ))}
              </div>
            )}
            <ToolContent content={item.content} />
          </div>
        </details>
      );
    }
    case "plan":
      return (
        <div className="plan">
          <div className="plan-title">{t("chat.plan")}</div>
          {item.entries.map((e, i) => (
            <div key={i} className={`plan-entry ${e.status}`}>
              {PLAN_MARK[e.status] ?? "•"} {e.content}
            </div>
          ))}
        </div>
      );
    case "permission":
      return (
        <div className={"permission" + (item.done ? " done" : "")}>
          <div className="permission-title">{t("chat.allow", item.toolCall.title ?? "tool")}</div>
          {item.toolCall.content ? (
            <div>
              <ToolContent content={item.toolCall.content} />
            </div>
          ) : item.toolCall.rawInput ? (
            <pre className="tool-output">{clip(JSON.stringify(item.toolCall.rawInput, null, 2))}</pre>
          ) : null}
          <div className="permission-buttons">
            {item.options.map((opt) => (
              <button
                key={opt.optionId}
                className={opt.kind.startsWith("reject") ? "secondary" : undefined}
                onClick={() => post({ type: "permission", id: item.requestId, optionId: opt.optionId })}
              >
                {opt.name}
              </button>
            ))}
          </div>
        </div>
      );
    case "notice":
    case "error":
      return <div className={item.kind}>{render(t, item.text)}</div>;
  }
});

/** Icon for a config option: by its ACP category, else by keywords in its id or name. */
function configIcon(option: acp.SessionConfigOption): string {
  switch (option.category) {
    case "mode":
      return shieldIcon;
    case "model":
      return cpuIcon;
    case "thought_level":
      return brainIcon;
  }
  const key = `${option.id} ${option.name}`.toLowerCase();
  if (/mode|permission/.test(key) && !/fast/.test(key)) return shieldIcon;
  if (/model/.test(key)) return cpuIcon;
  if (/effort|think|reason/.test(key)) return brainIcon;
  if (/fast|speed/.test(key)) return boltIcon;
  if (/agent/.test(key)) return robotIcon;
  return adjustmentsIcon;
}

function ConfigSelect({
  tab,
  option,
  onChange,
}: {
  tab: number;
  option: acp.SessionConfigOption & { type: "select" };
  onChange: (value: string) => void;
}) {
  const flat = option.options.flatMap((o) => ("options" in o ? o.options : [o]));
  return (
    <label className="config-item" title={option.description ? `${option.name}: ${option.description}` : option.name}>
      <span className="config-name" aria-label={option.name}>
        <Icon svg={configIcon(option)} />
      </span>
      <select
        value={option.currentValue}
        onChange={(e) => {
          onChange(e.target.value);
          post({ type: "setConfig", tab, configId: option.id, value: e.target.value });
        }}
      >
        {flat.map((o) => (
          <option key={o.value} value={o.value}>
            {o.name}
          </option>
        ))}
      </select>
    </label>
  );
}

interface AgentChoices {
  agents: ReadonlyArray<{ id: string; name: string }>;
  activeId?: string;
}

const MANAGE_AGENTS = "\0manage";

/** Picks the tab's agent from the installed and custom ones; the last entry opens the agent manager. */
function AgentSelect({ tab, choices }: { tab: TabInfo | undefined; choices: AgentChoices }) {
  const { t } = useL10n();
  const { agents, activeId } = choices;
  // A tab without a pick yet gets the default.
  const picked = tab?.agentId ?? activeId;
  const value = agents.find((a) => a.id === picked)?.id ?? "";
  return (
    <span id="agent" className="config-item" title={t("chat.switchAgent")}>
      <select
        value={value}
        onChange={(e) => {
          const id = e.target.value;
          if (id === MANAGE_AGENTS) post({ type: "manageAgents" });
          else if (id && tab) post({ type: "setAgent", tab: tab.id, id });
        }}
      >
        {value === "" && (
          <option value="" disabled>
            {t("chat.noAgentSelected")}
          </option>
        )}
        {agents.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
        <option value={MANAGE_AGENTS}>{t("chat.manageAgents")}</option>
      </select>
    </span>
  );
}

interface Usage {
  used: number;
  size: number;
  cost?: acp.Cost | null;
}

/** `compactAt`: where the agent auto-compacts, when that is before the end of the window. */
function UsageMeter({ usage, compactAt }: { usage: Usage | undefined; compactAt: number | undefined }) {
  const { t, lang } = useL10n();
  if (!usage) return <span id="usage" hidden />;
  const compact = new Intl.NumberFormat(lang, { notation: "compact", maximumFractionDigits: 1 });
  const exact = new Intl.NumberFormat(lang);
  const limit = compactAt !== undefined && compactAt < usage.size ? compactAt : usage.size;
  const ratio = limit > 0 ? Math.min(1, usage.used / limit) : 0;
  const percent = Math.round(ratio * 100);
  let title = t("chat.contextUsageTitle", exact.format(usage.used), exact.format(usage.size));
  if (limit < usage.size) {
    title += `\n${t("chat.autoCompactAt", exact.format(limit))}`;
  }
  if (usage.cost) {
    const cost = new Intl.NumberFormat(lang, { style: "currency", currency: usage.cost.currency });
    title += `\n${t("chat.sessionCost", cost.format(usage.cost.amount))}`;
  }
  return (
    <span id="usage" title={title} data-level={ratio >= 0.9 ? "high" : ratio >= 0.7 ? "medium" : "low"}>
      <span id="usage-meter">
        <span id="usage-fill" style={{ width: `${percent}%` }} />
      </span>
      <span id="usage-text">{t("chat.contextUsage", compact.format(usage.used), compact.format(limit), percent)}</span>
    </span>
  );
}

interface Status {
  text: string;
  busy?: boolean;
  needsLogin?: boolean;
  needsAgent?: boolean;
}

interface History {
  sessions: acp.SessionInfo[];
  loading?: boolean;
  unsupported?: boolean;
  canOpen?: boolean;
  currentId?: string;
  /** Sessions shown in a tab. */
  openIds?: string[];
}

/** "5 minutes ago" style label for an ISO timestamp. */
function relativeTime(lang: string, iso: string | null | undefined): string {
  const time = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(time)) return "";
  const seconds = (time - Date.now()) / 1000;
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31536000],
    ["month", 2592000],
    ["week", 604800],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  const format = new Intl.RelativeTimeFormat(lang, { numeric: "auto" });
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
  }
  return format.format(0, "minute");
}

function HistoryView({ history, onClose }: { history: History; onClose: () => void }) {
  const { t, lang } = useL10n();
  const sessions = [...history.sessions].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  const message = history.loading
    ? t("chat.historyLoading")
    : history.unsupported
      ? t("chat.historyUnsupported")
      : sessions.length === 0
        ? t("chat.historyEmpty")
        : history.canOpen
          ? undefined
          : t("chat.historyCannotOpen");
  return (
    <div id="history">
      <div id="history-header">
        <span id="history-title">{t("chat.history")}</span>
        <button className="icon-btn" title={t("chat.close")} aria-label={t("chat.close")} onClick={onClose}>
          <Icon svg={xIcon} />
        </button>
      </div>
      {message && <div className="history-message">{message}</div>}
      <ul id="history-list">
        {sessions.map((s) => (
          <li key={s.sessionId}>
            <button
              className="history-item"
              data-current={s.sessionId === history.currentId || undefined}
              data-open={history.openIds?.includes(s.sessionId) || undefined}
              disabled={!history.canOpen}
              title={s.title ?? s.sessionId}
              onClick={() => {
                post({ type: "openSession", sessionId: s.sessionId, cwd: s.cwd, title: s.title ?? undefined });
                onClose();
              }}
            >
              <span className="history-item-title">{s.title?.trim() || t("chat.untitled")}</span>
              <span className="history-item-meta">
                {s.sessionId === history.currentId
                  ? t("chat.currentSession")
                  : history.openIds?.includes(s.sessionId)
                    ? t("chat.openInTab")
                    : relativeTime(lang, s.updatedAt)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function nameFromUri(uri: string): string {
  const parts = decodeURIComponent(uri.replace(/[?#].*$/, "")).split("/").filter(Boolean);
  return parts[parts.length - 1] ?? uri;
}

/**
 * Splits `text` at the first occurrence of each item's token; an item whose token is gone from the text is left out.
 * At the same position the longer token wins, so "@a.ts (2)" isn't read as "@a.ts".
 */
function splitTokens<T extends { token: string }>(text: string, items: Iterable<T>): Array<string | T> {
  const left = [...items].sort((a, b) => b.token.length - a.token.length);
  const out: Array<string | T> = [];
  let from = 0;
  for (;;) {
    let next: { at: number; item: T } | undefined;
    for (const item of left) {
      const at = text.indexOf(item.token, from);
      if (at >= 0 && (!next || at < next.at)) next = { at, item };
    }
    if (!next) break;
    if (next.at > from) out.push(text.slice(from, next.at));
    out.push(next.item);
    left.splice(left.indexOf(next.item), 1);
    from = next.at + next.item.token.length;
  }
  if (from < text.length) out.push(text.slice(from));
  return out;
}

/** An inline token; `src` is set for images, which open in the lightbox. */
interface Token {
  token: string;
  src?: string;
}

/** `text` with its attachment tokens highlighted. */
function Tokens({ text, tokens }: { text: string; tokens: Token[] }) {
  const { t } = useL10n();
  const open = useContext(OpenPreview);
  const hover = useContext(HoverPreview);
  return splitTokens(text, tokens).map((part, i) =>
    typeof part === "string" ? (
      <Fragment key={i}>{part}</Fragment>
    ) : part.src ? (
      <mark
        key={i}
        className="token image"
        data-token={part.token}
        aria-label={t("chat.previewImage")}
        onMouseEnter={(e) => hover({ src: part.src!, rect: e.currentTarget.getBoundingClientRect() })}
        onMouseLeave={() => hover(undefined)}
        onClick={() => {
          hover(undefined);
          open({ src: part.src!, name: part.token.slice(1) });
        }}
      >
        {part.token}
      </mark>
    ) : (
      <mark key={i} className="token">
        {part.token}
      </mark>
    ),
  );
}

/** Data URI of an image attachment, if it is one. */
function imageSrc(a: Attachment): string | undefined {
  return a.kind === "data" && a.mimeType.startsWith("image/") ? `data:${a.mimeType};base64,${a.data}` : undefined;
}

/** Identifies attachments that are the same file or range; raw data never dedupes. */
function attachmentKey(a: Attachment): string | undefined {
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

function attachmentTitle(t: Translate, a: Attachment): string {
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
function editText(el: HTMLTextAreaElement, text: string, start: number, end: number): void {
  el.focus();
  el.setSelectionRange(start, end);
  if (!document.execCommand(text ? "insertText" : "delete", false, text)) el.setRangeText(text, start, end, "end");
}

/** URIs from VS Code (explorer, tabs) or other apps, one per line; "#" lines are comments. */
function urisFrom(dt: DataTransfer): string[] {
  const raw = dt.getData("application/vnd.code.uri-list") || dt.getData("text/uri-list");
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

/** The "@", "$" or "/" word being typed before the caret; `start` is the sigil, `end` the caret. */
interface Trigger {
  sigil: "@" | "$" | "/";
  start: number;
  end: number;
  query: string;
}

/** The trigger before the caret, if any: "@" and "$" start a word, "/" only the whole message. */
function triggerIn(el: HTMLTextAreaElement): Trigger | undefined {
  if (el.selectionStart !== el.selectionEnd) return undefined;
  const end = el.selectionStart;
  const before = el.value.slice(0, end);
  const m = /(^|\s)([@$])([^\s@$]*)$/.exec(before) ?? /^(\s*)(\/)(\S*)$/.exec(before);
  if (!m) return undefined;
  return { sigil: m[2] as Trigger["sigil"], start: m.index + m[1]!.length, end, query: m[3]! };
}

/** Names containing `query`, those starting with it first. */
function byName<T>(items: T[], name: (item: T) => string, query: string): T[] {
  const q = query.toLowerCase();
  return items
    .map((item) => ({ item, at: name(item).toLowerCase().indexOf(q) }))
    .filter((x) => x.at >= 0)
    .sort((a, b) => Number(a.at > 0) - Number(b.at > 0))
    .map((x) => x.item);
}

/** One row of the "@" / "$" / "/" popup. */
interface Suggestion {
  key: string;
  label: string;
  detail?: string;
  pick: () => void;
}

/** Everything the webview keeps per tab; the host only knows the session behind it. */
interface TabState {
  transcript: Transcript;
  config: acp.SessionConfigOption[];
  usage?: Usage;
  /** Auto-compact window the host read from the agent's settings. */
  compactAt?: number;
  status: Status;
  attachments: Attachment[];
  /** Slash commands the agent offers in this session. */
  commands: acp.AvailableCommand[];
  /** When the tab became busy; drives the elapsed time. */
  busySince?: number;
  /** Last session update while busy; a long silence shows the waiting row. */
  lastActivity?: number;
  /** The agent's terminals, by id. */
  terminals: Record<string, TerminalSnapshot>;
  changes?: ChangesMessage;
}

const NEW_TAB: TabState = { transcript: EMPTY, config: [], status: { text: "" }, attachments: [], commands: [], terminals: {} };

type TabsAction =
  | { type: "update"; tab: number; f: (state: TabState) => TabState }
  /** Drops the state of tabs that were closed. */
  | { type: "keep"; ids: number[] };

function tabStates(state: Record<number, TabState>, action: TabsAction): Record<number, TabState> {
  switch (action.type) {
    case "update":
      return { ...state, [action.tab]: action.f(state[action.tab] ?? NEW_TAB) };
    case "keep":
      return Object.fromEntries(action.ids.flatMap((id) => (state[id] ? [[id, state[id]]] : [])));
  }
}

/** Drag data type of a tab being reordered; the view's file drop ignores it. */
const TAB_DRAG_TYPE = "application/x-code-acp-tab";

const isTabDrag = (e: { dataTransfer: DataTransfer | null }) => e.dataTransfer?.types.includes(TAB_DRAG_TYPE) ?? false;

function TabStrip({
  tabs,
  states,
  active,
  onSelect,
}: {
  tabs: TabInfo[];
  states: Record<number, TabState>;
  active: number | undefined;
  onSelect: (id: number) => void;
}) {
  const { t, lang } = useL10n();
  const dateFormat = new Intl.DateTimeFormat(lang, { dateStyle: "medium", timeStyle: "short" });
  const strip = useRef<HTMLDivElement>(null);
  const [dragged, setDragged] = useState<number>();
  const [dropAt, setDropAt] = useState<{ id: number; after: boolean }>();
  const endDrag = () => {
    setDragged(undefined);
    setDropAt(undefined);
  };
  const drop = (target: { id: number; after: boolean }) => {
    const from = tabs.findIndex((x) => x.id === dragged);
    const at = tabs.findIndex((x) => x.id === target.id);
    if (dragged === undefined || from < 0 || at < 0) return;
    let index = at + (target.after ? 1 : 0);
    if (from < index) index--;
    if (index !== from) post({ type: "moveTab", tab: dragged, index });
  };
  useEffect(() => {
    strip.current?.querySelector("[data-active]")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active, tabs.length]);
  return (
    <div id="tabs" role="tablist">
      <div
        id="tab-list"
        ref={strip}
        // A vertical wheel scrolls the single row sideways.
        onWheel={(e) => {
          if (e.deltaX === 0) e.currentTarget.scrollLeft += e.deltaY;
        }}
      >
        {tabs.map((tab) => {
          const state = states[tab.id];
          const waiting = state?.transcript.items.some((i) => i.kind === "permission" && !i.done);
          const title = tab.title || t("chat.newTab");
          const tooltip = [
            waiting ? `${title} · ${t("chat.tabWaiting")}` : title,
            ...(tab.createdAt === undefined ? [] : [t("chat.tabCreated", dateFormat.format(tab.createdAt))]),
          ].join("\n");
          const pinLabel = t(tab.pinned ? "chat.unpinTab" : "chat.pinTab");
          return (
            <div
              key={tab.id}
              className="tab"
              role="tab"
              draggable
              aria-selected={tab.id === active}
              data-active={tab.id === active || undefined}
              data-busy={state?.status.busy || undefined}
              data-waiting={waiting || undefined}
              data-pinned={tab.pinned || undefined}
              data-dragging={tab.id === dragged || undefined}
              data-drop={dropAt?.id === tab.id ? (dropAt.after ? "after" : "before") : undefined}
              title={tooltip}
              // Native context menu: the `webview/context` tab commands in package.json.
              data-vscode-context={JSON.stringify({
                webviewSection: "tab",
                tab: tab.id,
                tabPinned: tab.pinned,
                preventDefaultContextMenuItems: true,
              })}
              onClick={() => onSelect(tab.id)}
              onAuxClick={(e) => {
                if (e.button === 1 && !tab.pinned) post({ type: "closeTab", tab: tab.id });
              }}
              onDragStart={(e) => {
                e.dataTransfer.setData(TAB_DRAG_TYPE, String(tab.id));
                e.dataTransfer.effectAllowed = "move";
                setDragged(tab.id);
              }}
              onDragEnd={endDrag}
              onDragOver={(e) => {
                if (!isTabDrag(e)) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                const box = e.currentTarget.getBoundingClientRect();
                const after = e.clientX > box.left + box.width / 2;
                if (dropAt?.id !== tab.id || dropAt.after !== after) setDropAt({ id: tab.id, after });
              }}
              onDrop={(e) => {
                if (!isTabDrag(e)) return;
                e.preventDefault();
                if (dropAt) drop(dropAt);
                endDrag();
              }}
            >
              <span className="tab-dot" />
              <span className="tab-title">{title}</span>
              <button
                className="tab-pin"
                title={pinLabel}
                aria-label={pinLabel}
                aria-pressed={tab.pinned}
                onClick={(e) => {
                  e.stopPropagation();
                  post({ type: "pinTab", tab: tab.id, pinned: !tab.pinned });
                }}
              >
                <Icon svg={tab.pinned ? pinFilledIcon : pinIcon} />
              </button>
              {!tab.pinned && (
                <button
                  className="tab-close"
                  title={t("chat.closeTab")}
                  aria-label={t("chat.closeTab")}
                  onClick={(e) => {
                    e.stopPropagation();
                    post({ type: "closeTab", tab: tab.id });
                  }}
                >
                  <Icon svg={xIcon} />
                </button>
              )}
            </div>
          );
        })}
      </div>
      <button className="icon-btn" id="new-tab" title={t("chat.newTab")} aria-label={t("chat.newTab")} onClick={() => post({ type: "newTab" })}>
        <Icon svg={plusIcon} />
      </button>
    </div>
  );
}

function App() {
  const { t } = useL10n();
  const [tabs, setTabs] = useState<TabInfo[]>([]);
  const [active, setActive] = useState<number>();
  const [states, dispatchTabs] = useReducer(tabStates, {});
  const [agents, setAgents] = useState<AgentChoices>({ agents: [] });
  const [includeFile, setIncludeFile] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [history, setHistory] = useState<History>();
  const messages = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const form = useRef<HTMLFormElement>(null);
  /** The active tab for callbacks registered once (drop, FileReader). */
  const activeRef = useRef(active);
  activeRef.current = active;
  /** Unsent text per tab; the textarea holds the active tab's. */
  const drafts = useRef(new Map<number, string>());
  const shownDraft = useRef<number>(undefined);
  /** A draft not yet sent to the extension, which keeps it across reloads. */
  const pendingDraft = useRef<{ tab: number; draft: Draft; timer: ReturnType<typeof setTimeout> }>(undefined);
  /** Per tab, the tokens and attachments last sent with a draft; while they stay the same, only the text goes out. */
  const sentAttachments = useRef(new Map<number, unknown[]>());
  /** Tabs whose saved draft was taken; later "tabs" messages don't overwrite what was typed since. */
  const seeded = useRef(new Set<number>());
  const statesRef = useRef(states);
  statesRef.current = states;

  const [preview, setPreview] = useState<Preview>();
  const closePreview = useCallback(() => setPreview(undefined), []);
  const [hover, setHover] = useState<Hover>();
  const current = (active !== undefined && states[active]) || NEW_TAB;
  const { transcript: state, config, usage, compactAt, status, attachments, commands, busySince, lastActivity, terminals: agentTerminals, changes } = current;
  const [followAgent, setFollowAgent] = useState(false);
  const checkpointTurns = changes?.turns;
  const shownTab = useMemo<ShownTab>(
    () => ({ id: active, busy: !!status.busy, checkpoints: new Set(checkpointTurns) }),
    [active, status.busy, checkpointTurns],
  );
  const now = useNow(busySince !== undefined);
  const elapsed = busySince !== undefined ? Math.max(0, now - busySince) : 0;
  const silent = busySince !== undefined ? Math.max(0, now - (lastActivity ?? busySince)) : 0;

  const update = (tab: number | undefined, f: (s: TabState) => TabState) => {
    if (tab !== undefined) dispatchTabs({ type: "update", tab, f });
  };
  const dispatch = (tab: number | undefined, action: Action) =>
    update(tab, (s) => ({ ...s, transcript: transcript(s.transcript, action) }));

  const error = (key: Parameters<Translate>[0], ...args: unknown[]) =>
    dispatch(activeRef.current, { type: "add", item: { kind: "error", text: { key, args } } });

  /** Files and snippets per tab, by the token that stands for them in the composer text. */
  const inline = useRef(new Map<number, Map<string, Attachment>>());
  /** Mirrors the textarea for the token highlight behind it. */
  const [inputText, setInputText] = useState("");
  const backdrop = useRef<HTMLDivElement>(null);

  function inlineOf(tab: number): Map<string, Attachment> {
    let map = inline.current.get(tab);
    if (!map) inline.current.set(tab, (map = new Map()));
    return map;
  }

  /** Adds `a` as a token at the caret, or in place of the typed trigger `at` (which also gives the sigil). */
  function addAttachment(a: Attachment, at?: Trigger): void {
    const tab = activeRef.current;
    const el = input.current;
    if (tab === undefined || !el) {
      update(tab, (s) => ({ ...s, attachments: [...s.attachments, a] }));
      return;
    }
    const start = at?.start ?? el.selectionStart;
    const end = at?.end ?? el.selectionEnd;
    // Attachments go inline as a token; a file already in the text is not added again.
    const key = attachmentKey(a);
    const tokens = inlineOf(tab);
    for (const [token, x] of tokens) {
      if (!el.value.includes(token)) tokens.delete(token);
      else if (key !== undefined && attachmentKey(x) === key) {
        if (at) editText(el, "", start, end);
        autosize();
        return;
      }
    }
    const sigil = at?.sigil ?? "@";
    let token = `${sigil}${a.name}`;
    for (let n = 2; tokens.has(token); n++) token = `${sigil}${a.name} (${n})`;
    tokens.set(token, a);
    const space = start > 0 && !/\s/.test(el.value[start - 1]!) ? " " : "";
    editText(el, `${space}${token} `, start, end);
    autosize();
  }

  const [trigger, setTrigger] = useState<Trigger>();
  const [selected, setSelected] = useState(0);
  const [files, setFiles] = useState<FileSuggestion[]>([]);
  const [terminals, setTerminals] = useState<TerminalSuggestion[]>([]);
  const [skills, setSkills] = useState<SkillSuggestion[]>([]);
  /** Id of the latest file search; older answers are dropped. */
  const searchId = useRef(0);
  /** Start of the trigger closed with Escape; it stays closed until the caret leaves it. */
  const dismissed = useRef<number>(undefined);

  /** Opens, updates or closes the popup for the text before the caret. */
  function refreshTrigger(): void {
    const el = input.current;
    let next = el ? triggerIn(el) : undefined;
    // The text of a token already placed is not a trigger.
    if (next && active !== undefined && [...inlineOf(active).keys()].some((x) => el!.value.startsWith(x, next!.start))) next = undefined;
    if (next?.start !== dismissed.current) dismissed.current = undefined;
    if (dismissed.current !== undefined) next = undefined;
    if (next?.sigil === trigger?.sigil && next?.query === trigger?.query && next?.start === trigger?.start) {
      if (next && next.end !== trigger?.end) setTrigger(next);
      return;
    }
    setTrigger(next);
    setSelected(0);
    if (next?.sigil === "@") {
      // Results of an earlier "@" don't belong to this one.
      if (trigger?.sigil !== "@" || trigger.start !== next.start) {
        setFiles([]);
        setTerminals([]);
      }
      post({ type: "searchFiles", id: ++searchId.current, query: next.query });
    }
    if (next?.sigil === "$" && trigger?.sigil !== "$") post({ type: "listSkills" });
  }

  /** Replaces the typed trigger with `text`. */
  function replaceTrigger(at: Trigger, text: string): void {
    const el = input.current;
    if (!el) return;
    editText(el, text, at.start, at.end);
    autosize();
  }

  const suggestions: Suggestion[] = !trigger
    ? []
    : trigger.sigil === "/"
      ? byName(commands, (c) => c.name, trigger.query).map((c) => ({
          key: c.name,
          label: `/${c.name}`,
          detail: c.description,
          pick: () => replaceTrigger(trigger, `/${c.name} `),
        }))
      : trigger.sigil === "$"
        ? byName(skills, (s) => s.name, trigger.query).map((s) => ({
            key: s.uri,
            label: `$${s.name}`,
            detail: s.description,
            pick: () => addAttachment({ kind: "uri", uri: s.uri, name: s.name }, trigger),
          }))
        : [
            ...terminals.map((c) => ({
              key: `terminal:${c.id}`,
              label: c.label,
              detail: c.detail,
              // The output stays in the extension until picked; it comes back as "addAttachments".
              pick: () => {
                replaceTrigger(trigger, "");
                post({ type: "attachTerminal", id: c.id });
              },
            })),
            ...files.map((f) => ({
              key: f.uri,
              label: f.folder ? `${f.name}/` : f.name,
              detail: f.path,
              pick: () => addAttachment({ kind: "uri", uri: f.uri, name: f.name }, trigger),
            })),
          ];
  const shown = Math.min(selected, suggestions.length - 1);

  function pick(s: Suggestion): void {
    setTrigger(undefined);
    s.pick();
    input.current?.focus();
  }

  /** Popup keys; true when the key was used. */
  function suggestKey(e: ReactKeyboardEvent<HTMLTextAreaElement>): boolean {
    if (!trigger || suggestions.length === 0 || e.nativeEvent.isComposing) return false;
    switch (e.key) {
      case "ArrowDown":
        setSelected((shown + 1) % suggestions.length);
        return true;
      case "ArrowUp":
        setSelected((shown - 1 + suggestions.length) % suggestions.length);
        return true;
      case "Enter":
      case "Tab":
        if (e.shiftKey) return false;
        pick(suggestions[shown]!);
        return true;
      case "Escape":
        dismissed.current = trigger.start;
        setTrigger(undefined);
        return true;
    }
    return false;
  }

  /** Backspace right after a token deletes the whole token. */
  function deleteToken(): boolean {
    const el = input.current;
    const tab = activeRef.current;
    if (!el || tab === undefined || el.selectionStart !== el.selectionEnd) return false;
    const before = el.value.slice(0, el.selectionStart);
    const token = [...inlineOf(tab).keys()].sort((a, b) => b.length - a.length).find((x) => before.endsWith(x));
    if (!token) return false;
    editText(el, "", el.selectionStart - token.length, el.selectionStart);
    autosize();
    return true;
  }

  /** Inserts `text` as a Markdown quote at the caret. */
  function quote(text: string): void {
    const el = input.current;
    if (!el) return;
    const before = el.value.slice(0, el.selectionStart);
    const lead = before && !before.endsWith("\n") ? "\n\n" : "";
    const quoted = text.trimEnd().split(/\r?\n/).map((l) => (l ? `> ${l}` : ">")).join("\n");
    editText(el, `${lead}${quoted}\n\n`, el.selectionStart, el.selectionEnd);
    el.focus();
    autosize();
  }

  function readFile(file: File): void {
    if (file.size > MAX_DATA_BYTES) {
      error("chat.tooLarge", file.name);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      addAttachment({
        kind: "data",
        name: file.name || `clipboard-${Date.now()}.${(file.type.split("/")[1] || "bin").replace(/\W.*$/, "")}`,
        mimeType: file.type,
        data: result.slice(result.indexOf(",") + 1),
      });
    };
    reader.onerror = () => error("chat.readFailed", file.name);
    reader.readAsDataURL(file);
  }

  /** Handles a DataTransfer from drop or paste. Returns true when something was attached. */
  function takeTransfer(dt: DataTransfer): boolean {
    const uris = urisFrom(dt);
    if (uris.length) {
      for (const uri of uris) addAttachment({ kind: "uri", uri, name: nameFromUri(uri) });
      return true;
    }
    const items = Array.from(dt.items ?? []).filter((it) => it.kind === "file");
    if (!items.length) return false;
    for (const item of items) {
      if (item.webkitGetAsEntry?.()?.isDirectory) {
        error("chat.externalFolder");
        continue;
      }
      const file = item.getAsFile();
      if (file) readFile(file);
    }
    return true;
  }

  useMessages((msg) => {
    // Messages about one conversation name their tab.
    const tab: number | undefined = msg.tab ?? activeRef.current;
    switch (msg.type) {
      case "tabs":
        setTabs(msg.tabs);
        setActive(msg.active);
        dispatchTabs({ type: "keep", ids: msg.tabs.map((x: TabInfo) => x.id) });
        // After a reload the extension holds the drafts.
        for (const { id, draft } of msg.tabs as TabInfo[]) {
          if (seeded.current.has(id)) continue;
          seeded.current.add(id);
          if (!draft) continue;
          drafts.current.set(id, draft.text);
          inline.current.set(id, new Map(draft.inline.map((x) => [x.token, x.attachment])));
          if (draft.attachments.length > 0) update(id, (s) => ({ ...s, attachments: draft.attachments }));
        }
        return;
      case "update":
        update(tab, (s) => (s.status.busy ? { ...s, lastActivity: Date.now() } : s));
        return handleUpdate(tab, msg.update);
      case "userMessage":
        return dispatch(tab, { type: "add", item: { kind: "userMessage", text: msg.text, attachments: msg.attachments ?? [], turn: msg.turn } });
      case "terminal": {
        const snapshot: TerminalSnapshot = msg.snapshot;
        return update(tab, (s) => ({ ...s, terminals: { ...s.terminals, [snapshot.terminalId]: snapshot } }));
      }
      case "changes":
        return update(tab, (s) => ({ ...s, changes: { files: msg.files, turns: msg.turns } }));
      case "followAgent":
        return setFollowAgent(msg.enabled);
      case "turnEnd":
        return dispatch(
          tab,
          msg.stopReason === "end_turn"
            ? { type: "endStream" }
            : { type: "add", item: { kind: "notice", text: { key: "chat.stopReason", args: [msg.stopReason] } } },
        );
      case "session":
        // A loaded session's replayed history ends here.
        dispatch(tab, { type: "endStream" });
        return update(tab, (s) => ({ ...s, config: msg.configOptions ?? [] }));
      case "history":
        return setHistory(msg);
      case "notice":
        return dispatch(tab, { type: "add", item: { kind: "notice", text: { key: msg.key } } });
      case "compactWindow":
        return update(tab, (s) => ({ ...s, compactAt: msg.size ?? undefined }));
      case "configOptions":
        if (msg.configOptions) update(tab, (s) => ({ ...s, config: msg.configOptions }));
        return;
      case "permissionRequest":
        return dispatch(tab, {
          type: "add",
          item: {
            kind: "permission",
            requestId: msg.id,
            toolCall: { ...msg.toolCall, content: clipContent(msg.toolCall.content) },
            options: msg.options,
            done: false,
          },
        });
      case "permissionDone":
        return dispatch(tab, { type: "permissionDone", requestId: msg.id });
      case "status":
        return update(tab, (s) => {
          const busySince = msg.busy ? (s.busySince ?? Date.now()) : undefined;
          return { ...s, status: msg, busySince, lastActivity: msg.busy ? s.lastActivity : undefined };
        });
      case "error":
        return dispatch(tab, { type: "add", item: { kind: "error", text: { raw: msg.text } } });
      case "agent":
        return setAgents({ agents: msg.agents, activeId: msg.activeId });
      case "addAttachments":
        for (const a of msg.attachments) addAttachment(a);
        input.current?.focus();
        return;
      case "quote":
        return quote(msg.text);
      case "files":
        if (msg.id === searchId.current) {
          setFiles(msg.files);
          setTerminals(msg.terminals ?? []);
        }
        return;
      case "skills":
        return setSkills(msg.skills);
      case "reset":
        dispatch(tab, { type: "reset" });
        update(tab, (s) => ({ ...s, usage: undefined, compactAt: undefined, terminals: {} }));
        return;
    }
  });
  // After useMessages, so the listener is in place before the extension answers.
  useEffect(() => post({ type: "ready" }), []);

  function handleUpdate(tab: number | undefined, u: acp.SessionUpdate): void {
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
        return dispatch(tab, { type: "chunk", kind: "assistant", text: contentText(u.content) });
      case "agent_thought_chunk":
        return dispatch(tab, { type: "chunk", kind: "thought", text: contentText(u.content) });
      case "user_message_chunk":
        return dispatch(
          tab,
          u.content.type === "image"
            ? { type: "chunk", kind: "user", text: "", image: `data:${u.content.mimeType};base64,${u.content.data}` }
            : { type: "chunk", kind: "user", text: contentText(u.content) },
        );
      case "tool_call":
      case "tool_call_update":
        return dispatch(tab, { type: "toolCall", update: u });
      case "plan":
        return dispatch(tab, { type: "plan", entries: u.entries });
      case "config_option_update":
        return update(tab, (s) => ({ ...s, config: u.configOptions }));
      case "available_commands_update":
        return update(tab, (s) => ({ ...s, commands: u.availableCommands }));
      case "usage_update":
        return update(tab, (s) => ({ ...s, usage: { used: u.used, size: u.size, cost: u.cost } }));
      case "session_info_update":
        // The host renames the tab.
        return;
      default: {
        // Not in the ACP schema, but some agents send it.
        const notice = u as { sessionUpdate: string; message?: string; text?: string };
        if (notice.sessionUpdate === "notice") {
          dispatch(tab, { type: "add", item: { kind: "notice", text: { raw: notice.message ?? notice.text ?? JSON.stringify(u) } } });
        }
      }
    }
  }

  function selectTab(id: number): void {
    if (id === active) return;
    setActive(id);
    setHistory(undefined);
    post({ type: "selectTab", tab: id });
  }

  // Swaps the composer text when another tab becomes active.
  useLayoutEffect(() => {
    const el = input.current;
    if (!el || shownDraft.current === active) return;
    if (shownDraft.current !== undefined) drafts.current.set(shownDraft.current, el.value);
    for (const id of drafts.current.keys()) {
      if (!tabs.some((x) => x.id === id)) drafts.current.delete(id);
    }
    for (const id of inline.current.keys()) {
      if (!tabs.some((x) => x.id === id)) inline.current.delete(id);
    }
    for (const id of sentAttachments.current.keys()) {
      if (!tabs.some((x) => x.id === id)) sentAttachments.current.delete(id);
    }
    el.value = (active !== undefined && drafts.current.get(active)) || "";
    shownDraft.current = active;
    setTrigger(undefined);
    autosize();
    el.focus();
  }, [active]);

  // Reloads an open history list when the active tab switches agent; the list is per agent.
  const activeAgentId = tabs.find((x) => x.id === active)?.agentId;
  const historyAgent = useRef(activeAgentId);
  useEffect(() => {
    if (history && historyAgent.current !== activeAgentId) post({ type: "history" });
    historyAgent.current = activeAgentId;
  }, [activeAgentId]);

  useEffect(() => {
    if (!history) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setHistory(undefined);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [!history]);

  useLayoutEffect(() => {
    const el = messages.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.items, active]);

  // VS Code builds the native context menu from `data-vscode-context`; the selection is read here,
  // in the capture phase, so it is current when VS Code's own listener runs.
  useEffect(() => {
    const onContextMenu = () => {
      const el = messages.current;
      if (!el) return;
      const sel = window.getSelection();
      const selectedText = sel && !sel.isCollapsed && el.contains(sel.anchorNode) ? sel.toString() : "";
      el.dataset.vscodeContext = JSON.stringify({ webviewSection: "messages", selectedText });
    };
    window.addEventListener("contextmenu", onContextMenu, true);
    return () => window.removeEventListener("contextmenu", onContextMenu, true);
  }, []);

  // Drops anywhere in the view attach files; capture so the textarea's own drop handling never runs.
  useEffect(() => {
    let depth = 0;
    const enter = (e: DragEvent) => {
      if (isTabDrag(e)) return;
      e.preventDefault();
      depth++;
      setDragging(true);
    };
    const leave = (e: DragEvent) => {
      if (isTabDrag(e)) return;
      if (--depth <= 0) {
        depth = 0;
        setDragging(false);
      }
    };
    const over = (e: DragEvent) => {
      if (isTabDrag(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const drop = (e: DragEvent) => {
      if (isTabDrag(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      if (!e.dataTransfer) return;
      const el = input.current;
      if (!takeTransfer(e.dataTransfer) && el) {
        const text = e.dataTransfer.getData("text/plain");
        if (text) editText(el, text, el.selectionStart, el.selectionEnd);
        autosize();
      }
      el?.focus();
    };
    window.addEventListener("dragenter", enter, true);
    window.addEventListener("dragleave", leave, true);
    window.addEventListener("dragover", over, true);
    window.addEventListener("drop", drop, true);
    return () => {
      window.removeEventListener("dragenter", enter, true);
      window.removeEventListener("dragleave", leave, true);
      window.removeEventListener("dragover", over, true);
      window.removeEventListener("drop", drop, true);
    };
  }, []);

  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>): void {
    const dt = e.clipboardData;
    // Plain text keeps the default paste; only files (e.g. screenshots) become attachments.
    if (Array.from(dt.items).some((it) => it.kind === "file") && takeTransfer(dt)) e.preventDefault();
  }

  function autosize(): void {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
    setInputText(el.value);
    syncScroll();
    saveDraft(el.value);
  }

  function flushDraft(): void {
    const pending = pendingDraft.current;
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingDraft.current = undefined;
    const { tab, draft } = pending;
    // Attachments can be megabytes of base64; resending them on every keystroke pause is wasted work.
    const refs = [...draft.inline.flatMap((x) => [x.token, x.attachment]), ...draft.attachments];
    const last = sentAttachments.current.get(tab);
    if (last && last.length === refs.length && last.every((x, i) => x === refs[i])) {
      post({ type: "draftText", tab, text: draft.text });
      return;
    }
    sentAttachments.current.set(tab, refs);
    post({ type: "draft", tab, draft });
  }

  /** Sends the active tab's composer content to the extension, at most every 300 ms. */
  function saveDraft(text: string): void {
    const tab = activeRef.current;
    if (tab === undefined) return;
    const draft: Draft = {
      text,
      inline: [...inlineOf(tab)].filter(([token]) => text.includes(token)).map(([token, attachment]) => ({ token, attachment })),
      attachments: statesRef.current[tab]?.attachments ?? [],
    };
    if (pendingDraft.current?.tab !== tab) flushDraft();
    else clearTimeout(pendingDraft.current.timer);
    pendingDraft.current = { tab, draft, timer: setTimeout(flushDraft, 300) };
  }

  // Attachments outside the text change without an edit.
  useEffect(() => {
    if (input.current) saveDraft(input.current.value);
  }, [attachments]);

  /** The image token drawn under the pointer; the backdrop sits behind the textarea, so hit-test its rects. */
  function imageTokenAt(x: number, y: number): { src: string; name: string; token: string; rect: DOMRect } | undefined {
    if (active === undefined) return undefined;
    for (const mark of backdrop.current?.querySelectorAll<HTMLElement>("mark.image") ?? []) {
      for (const rect of mark.getClientRects()) {
        if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue;
        const token = mark.dataset.token!;
        const a = inlineOf(active).get(token);
        const src = a && imageSrc(a);
        return a && src ? { src, name: a.name, token, rect } : undefined;
      }
    }
    return undefined;
  }

  function syncScroll(): void {
    if (backdrop.current && input.current) backdrop.current.scrollTop = input.current.scrollTop;
  }

  function submit(): void {
    const el = input.current;
    if (!el || active === undefined) return;
    const text = el.value;
    const tokens = [...inlineOf(active)].map(([token, a]) => ({ ...a, token }));
    const parts: PromptPart[] = [...splitTokens(text, tokens), ...attachments];
    if (parts.every((p) => typeof p === "string" && !p.trim())) return;
    el.value = "";
    autosize();
    post({ type: "send", tab: active, parts, includeActiveFile: includeFile });
    update(active, (s) => ({ ...s, attachments: [] }));
    inline.current.delete(active);
  }

  return (
    <OpenPreview.Provider value={setPreview}>
      <HoverPreview.Provider value={setHover}>
      <ShownTab.Provider value={shownTab}>
      <Terminals.Provider value={agentTerminals}>
        <TabStrip tabs={tabs} states={states} active={active} onSelect={selectTab} />
        {history && <HistoryView history={history} onClose={() => setHistory(undefined)} />}
        <div id="messages" ref={messages} hidden={!!history}>
          {state.items.length === 0 && <div className="empty">{t("chat.empty")}</div>}
          {groupActivity(state.items).map((entry) =>
            Array.isArray(entry) ? <ActivityView key={entry[0]!.id} items={entry} /> : <ItemView key={entry.id} item={entry} />,
          )}
          {busySince !== undefined && silent >= WAITING_AFTER_MS && (
            <div className="waiting">{t("chat.waiting", formatDuration(silent))}</div>
          )}
        </div>
        <div id="drop-overlay" className={dragging ? "visible" : undefined}>
          {t("chat.dropHint")}
        </div>
        {active !== undefined && <ChangesBar tab={active} changes={changes} />}
        <div id="status">
          <span id="status-text">
            {status.text}
            {busySince !== undefined && elapsed >= 1000 && <span className="elapsed"> · {formatDuration(elapsed)}</span>}
          </span>
          <button id="login" hidden={!status.needsLogin} onClick={() => post({ type: "login" })}>
            {t("chat.login")}
          </button>
          <button id="manage" hidden={!status.needsAgent} onClick={() => post({ type: "selectAgent" })}>
            {t("chat.installAgent")}
          </button>
          <span className="spacer" />
          {active !== undefined && (changes?.turns.length ?? 0) > 0 && (
            <button
              id="checkpoints"
              className="icon-btn small"
              title={t("checkpoints.pick")}
              aria-label={t("checkpoints.pick")}
              onClick={() => post({ type: "pickCheckpoint", tab: active })}
            >
              <Icon svg={restoreIcon} />
            </button>
          )}
          <button
            id="follow"
            className="icon-btn small"
            title={t("chat.followAgent")}
            aria-label={t("chat.followAgent")}
            aria-pressed={followAgent}
            onClick={() => post({ type: "setFollowAgent", enabled: !followAgent })}
          >
            <Icon svg={followAgent ? eyeIcon : eyeOffIcon} />
          </button>
          <UsageMeter usage={usage} compactAt={compactAt} />
        </div>
        <form
          id="composer"
          ref={form}
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          {suggestions.length > 0 && (
            <div id="suggest" role="listbox">
              {suggestions.map((s, i) => (
                <div
                  key={s.key}
                  role="option"
                  className="suggest-item"
                  aria-selected={i === shown}
                  ref={i === shown ? (n) => n?.scrollIntoView({ block: "nearest" }) : undefined}
                  // Keeps the focus in the textarea.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(s);
                  }}
                  onMouseMove={() => i !== shown && setSelected(i)}
                >
                  <span className="suggest-label">{s.label}</span>
                  {s.detail && <span className="suggest-detail">{s.detail}</span>}
                </div>
              ))}
            </div>
          )}
          <div id="attachments">
            {attachments.map((a, i) => (
              <span key={attachmentKey(a) ?? i} className="chip" title={attachmentTitle(t, a)}>
                {imageSrc(a) && (
                  <img
                    className="chip-preview"
                    src={imageSrc(a)}
                    title={t("chat.previewImage")}
                    onClick={() =>
                      setPreview({
                        src: imageSrc(a)!,
                        name: a.name,
                        replace: (b) => update(active, (s) => ({ ...s, attachments: s.attachments.map((x) => (x === a ? b : x)) })),
                      })
                    }
                  />
                )}
                <span>{a.name}</span>
                <button
                  type="button"
                  className="chip-remove"
                  title={t("chat.removeAttachment")}
                  onClick={() => update(active, (s) => ({ ...s, attachments: s.attachments.filter((x) => x !== a) }))}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
          <div id="input-box">
            {/* Same text as the textarea, transparent, so tokens get a highlight behind them. */}
            <div id="input-backdrop" ref={backdrop} aria-hidden="true">
              <Tokens
                text={inputText}
                tokens={active !== undefined ? [...inlineOf(active)].map(([token, a]) => ({ token, src: imageSrc(a) })) : []}
              />
              {"\n"}
            </div>
            <textarea
              id="input"
              ref={input}
              rows={2}
              placeholder={t("chat.placeholder")}
              title={t("chat.inputTitle")}
              onInput={() => {
                autosize();
                refreshTrigger();
              }}
              onSelect={refreshTrigger}
              onBlur={() => setTrigger(undefined)}
              onScroll={() => {
                syncScroll();
                setHover(undefined);
              }}
              onPaste={onPaste}
              onMouseMove={(e) => {
                const hit = imageTokenAt(e.clientX, e.clientY);
                e.currentTarget.style.cursor = hit ? "pointer" : "";
                // Keep the same object while on the same token, so moving within it doesn't re-render.
                setHover((h) => (hit ? (h?.src === hit.src && h.rect.top === hit.rect.top ? h : hit) : undefined));
              }}
              onMouseLeave={() => setHover(undefined)}
              onClick={(e) => {
                const hit = imageTokenAt(e.clientX, e.clientY);
                if (hit && e.currentTarget.selectionStart === e.currentTarget.selectionEnd) {
                  setHover(undefined);
                  const tab = active!;
                  setPreview({
                    src: hit.src,
                    name: hit.name,
                    replace: (b) => {
                      inlineOf(tab).set(hit.token, b);
                      if (input.current) saveDraft(input.current.value);
                    },
                  });
                }
              }}
              onKeyDown={(e) => {
                if (suggestKey(e)) {
                  e.preventDefault();
                } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  form.current?.requestSubmit();
                } else if (e.key === "Backspace" && !e.nativeEvent.isComposing && deleteToken()) {
                  e.preventDefault();
                }
              }}
            />
          </div>
          <div id="actions">
            <AgentSelect tab={tabs.find((x) => x.id === active)} choices={agents} />
            <label title={t("chat.includeFile")}>
              <input type="checkbox" id="include-file" checked={includeFile} onChange={(e) => setIncludeFile(e.target.checked)} />
              <Icon svg={paperclipIcon} />
              <span className="label-text">{t("chat.includeFile")}</span>
            </label>
            <span className="spacer" />
            <button
              type="button"
              id="cancel"
              className="icon-btn"
              title={t("chat.stop")}
              aria-label={t("chat.stop")}
              hidden={!status.busy}
              onClick={() => active !== undefined && post({ type: "cancel", tab: active })}
            >
              <Icon svg={stopIcon} />
            </button>
            <button
              type="submit"
              id="send"
              className="icon-btn"
              title={t("chat.sendTitle")}
              aria-label={t("chat.send")}
              disabled={!!status.busy}
            >
              <Icon svg={arrowUpIcon} />
            </button>
          </div>
        </form>
        <div id="toolbar">
          <div
            id="config"
            // A vertical wheel scrolls the single row sideways.
            onWheel={(e) => {
              if (e.deltaX === 0) e.currentTarget.scrollLeft += e.deltaY;
            }}
          >
            {active !== undefined &&
              config.map((opt) =>
                opt.type === "select" ? (
                  <ConfigSelect
                    key={opt.id}
                    tab={active}
                    option={opt}
                    // Shown right away; the agent's answer replaces the whole list.
                    onChange={(value) =>
                      update(active, (s) => ({
                        ...s,
                        config: s.config.map((o) => (o.id === opt.id ? ({ ...o, currentValue: value } as typeof o) : o)),
                      }))
                    }
                  />
                ) : null,
              )}
          </div>
        </div>
        {preview && (
          <Lightbox
            key={preview.src}
            src={preview.src}
            alt={preview.name}
            onClose={closePreview}
            saveLabel={t(preview.replace ? "lightbox.save" : "lightbox.attach")}
            onSave={(src) => {
              const data = src.slice(src.indexOf(",") + 1);
              if (preview.replace) preview.replace({ kind: "data", name: preview.name, mimeType: "image/png", data });
              else addAttachment({ kind: "data", name: `${preview.name.replace(/\.[^.]*$/, "") || "image"}-annotated.png`, mimeType: "image/png", data });
              closePreview();
              input.current?.focus();
            }}
            onPopOut={() => {
              post({ type: "openImage", src: preview.src, name: preview.name });
              closePreview();
            }}
          />
        )}
        {hover && !preview && <HoverThumb hover={hover} />}
      </Terminals.Provider>
      </ShownTab.Provider>
      </HoverPreview.Provider>
    </OpenPreview.Provider>
  );
}

mount(<App />);
