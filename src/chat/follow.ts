import type * as acp from "@agentclientprotocol/sdk";
import { Effect, FileSystem, Option } from "effect";
import * as vscode from "vscode";
import { thenable, type AppServices } from "../runtime";
import type { Tab } from "./tabs";

/** How long the lines the agent just changed stay highlighted. */
const HIGHLIGHT_MS = 3000;

/** A text the agent replaced in a file, from a tool call's `diff` content. */
export interface FollowDiff {
  readonly path: string;
  readonly oldText: string | null;
  readonly newText: string;
}

/** What is known of a tool call so far: updates only carry the fields that changed. */
export interface FollowedCall {
  locations: ReadonlyArray<acp.ToolCallLocation>;
  diffs: ReadonlyArray<FollowDiff>;
  status?: acp.ToolCallStatus | null;
}

/** Where to show the agent at work: 0-based lines, inclusive; `highlight` for lines it changes. */
export interface FollowTarget {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly highlight: boolean;
}

/** Folds a `tool_call` or `tool_call_update` into what is known of the call. */
export const mergeCall = (
  call: FollowedCall | undefined,
  update: Pick<acp.ToolCallUpdate, "locations" | "content" | "status">,
): FollowedCall => {
  const diffs = update.content?.flatMap((c) =>
    c.type === "diff" ? [{ path: c.path, oldText: c.oldText ?? null, newText: c.newText }] : [],
  );
  return {
    locations: update.locations ?? call?.locations ?? [],
    diffs: diffs ?? call?.diffs ?? [],
    status: update.status ?? call?.status,
  };
};

/** The 0-based lines of the first occurrence of `needle` in `text`. */
export const lineSpan = (text: string, needle: string): { startLine: number; endLine: number } | undefined => {
  const at = needle === "" ? -1 : text.indexOf(needle);
  if (at < 0) {
    return undefined;
  }
  const startLine = countLines(text, 0, at);
  // A trailing newline ends the last line rather than starting another one.
  const end = needle.endsWith("\n") ? at + needle.length - 1 : at + needle.length;
  return { startLine, endLine: startLine + countLines(text, at, end) };
};

const countLines = (text: string, from: number, to: number): number => {
  let lines = 0;
  for (let i = text.indexOf("\n", from); i >= 0 && i < to; i = text.indexOf("\n", i + 1)) {
    lines++;
  }
  return lines;
};

/**
 * Where the call is working in `path`, given the file's current text (undefined when it can't be read). An edit is
 * found by its new text once written, else by the text it replaces; without a diff, the location's line is used.
 */
export const followTarget = (call: FollowedCall, path: string, text: string | undefined): FollowTarget => {
  const location = call.locations.find((l) => l.path === path);
  const diff = call.diffs.find((d) => d.path === path);
  if (diff && text !== undefined) {
    const span = lineSpan(text, diff.newText) ?? (diff.oldText ? lineSpan(text, diff.oldText) : undefined);
    if (span) {
      return { path, ...span, highlight: true };
    }
  }
  const line = location?.line ? Math.max(0, location.line - 1) : 0;
  return { path, startLine: line, endLine: line, highlight: false };
};

/** codeAcp.followAgent: opens where the active tab's agent reads and edits, and highlights what it changed. */
export class Follower implements vscode.Disposable {
  private readonly calls = new Map<string, FollowedCall>();
  /** Last target shown, so repeated updates of a tool call don't reveal it again. */
  private last?: string;
  private readonly decoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor("editor.rangeHighlightBackground"),
    overviewRulerColor: new vscode.ThemeColor("editor.rangeHighlightBackground"),
    overviewRulerLane: vscode.OverviewRulerLane.Full,
    isWholeLine: true,
  });
  private highlighted?: { editor: vscode.TextEditor; timer: ReturnType<typeof setTimeout> };

  constructor(
    private enabled: boolean,
    private readonly host: {
      activeTab(): Tab;
      run<E>(effect: Effect.Effect<void, E, AppServices>, tab: Tab): void;
    },
  ) {}

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.last = undefined;
  }

  /** A `tool_call` or `tool_call_update` of `tab`'s agent. */
  toolCall(tab: Tab, update: acp.ToolCall | acp.ToolCallUpdate): void {
    const key = `${tab.id}:${update.toolCallId}`;
    const call = mergeCall(this.calls.get(key), update);
    if (call.status === "completed" || call.status === "failed") {
      this.calls.delete(key);
    } else {
      this.calls.set(key, call);
    }
    const path = call.locations[0]?.path ?? call.diffs[0]?.path;
    if (path !== undefined && call.status !== "failed") {
      this.show(tab, call, path);
    }
  }

  /** The agent wrote `path` through the client: shown where its pending tool call changed it, else at the top. */
  fileWritten(tab: Tab, path: string): void {
    const call = [...this.calls.entries()].find(
      ([key, c]) => key.startsWith(`${tab.id}:`) && (c.locations.some((l) => l.path === path) || c.diffs.some((d) => d.path === path)),
    )?.[1];
    this.show(tab, call ?? { locations: [{ path }], diffs: [] }, path);
  }

  /** Forgets a tab's tool calls, e.g. when it closes or starts over. */
  forget(tab: Tab): void {
    for (const key of this.calls.keys()) {
      if (key.startsWith(`${tab.id}:`)) {
        this.calls.delete(key);
      }
    }
  }

  private show(tab: Tab, call: FollowedCall, path: string): void {
    if (!this.enabled || tab !== this.host.activeTab()) {
      return;
    }
    this.host.run(
      Effect.gen({ self: this }, function* () {
        const fs = yield* FileSystem.FileSystem;
        // From disk: an editor showing the file may not have picked up the agent's write yet.
        const text = call.diffs.length ? yield* fs.readFileString(path).pipe(Effect.option) : undefined;
        const target = followTarget(call, path, text && Option.getOrUndefined(text));
        // A change is shown again once written, though it may sit on the lines it replaced.
        const key = `${target.path}:${target.startLine}-${target.endLine}${target.highlight ? `:${call.status}` : ""}`;
        if (key === this.last) {
          return;
        }
        this.last = key;
        const start = new vscode.Position(target.startLine, 0);
        const editor = yield* thenable(() =>
          vscode.window.showTextDocument(vscode.Uri.file(path), {
            preview: true,
            preserveFocus: true,
            selection: new vscode.Range(start, start),
          }),
        );
        const range = new vscode.Range(start, new vscode.Position(target.endLine, 0));
        editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        if (target.highlight) {
          this.highlight(editor, range);
        }
      }).pipe(
        // A file the agent is about to create does not exist yet: nothing to show.
        Effect.ignore,
      ),
      tab,
    );
  }

  private highlight(editor: vscode.TextEditor, range: vscode.Range): void {
    this.clearHighlight();
    editor.setDecorations(this.decoration, [range]);
    this.highlighted = { editor, timer: setTimeout(() => this.clearHighlight(), HIGHLIGHT_MS) };
  }

  private clearHighlight(): void {
    if (this.highlighted) {
      clearTimeout(this.highlighted.timer);
      this.highlighted.editor.setDecorations(this.decoration, []);
      this.highlighted = undefined;
    }
  }

  dispose(): void {
    this.clearHighlight();
    this.decoration.dispose();
  }
}
