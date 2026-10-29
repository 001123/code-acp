import type * as acp from "@agentclientprotocol/sdk";
import { Fragment, memo, useContext } from "react";
import type { SentAttachment } from "../../chat/protocol";
import { Icon } from "../icon";
import { diffLines, hunks } from "../lineDiff";
import { MarkdownView } from "../markdown";
import { useL10n, type Translate } from "../l10n";
import stopIcon from "@tabler/icons/filled/player-stop.svg";
import circleCheckIcon from "@tabler/icons/outline/circle-check.svg";
import circleDashedIcon from "@tabler/icons/outline/circle-dashed.svg";
import circleXIcon from "@tabler/icons/outline/circle-x.svg";
import loaderIcon from "@tabler/icons/outline/loader-2.svg";
import usersIcon from "@tabler/icons/outline/users.svg";
import diffIcon from "@tabler/icons/outline/file-diff.svg";
import restoreIcon from "@tabler/icons/outline/restore.svg";
import { OpenPreview, ShownTab, Terminals, type Hover } from "./context";
import { openFile, post } from "./post";
import { clip, contentText, type ActivityItem, type Item, type Text } from "./transcript";
import { Tokens } from "./tokens";

const HOVER_WIDTH = 240;
const HOVER_HEIGHT = 180;
const HOVER_GAP = 6;

/** Thumbnail floating above the hovered token, or below it when there is no room above. */
export function HoverThumb({ hover }: { hover: Hover }) {
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

/** A run of thoughts and tool calls, collapsed under one "Thinking" summary. */
export const ActivityView = memo(
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
export const ItemView = memo(function ItemView({ item }: { item: Item }) {
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
