// Messages and shapes shared by the chat view's host (src/chat/*) and its webview (src/ui/chat/*).
import type { TerminalSnapshot } from "../agentTerminals";
import type { ChangedFile } from "../fileChanges";

export type { ChangedFile, TerminalSnapshot };

export type FromWebview =
  | { type: "ready" }
  /**
   * The composer in order: text runs and the attachments between them. While the tab is busy it is queued, or with
   * `now` sent right away, stopping the turn. With `rewind`, it replaces the user message of that turn and the rest
   * of the conversation after it.
   */
  | { type: "send"; tab: number; parts: PromptPart[]; includeActiveFile: boolean; now?: boolean; rewind?: number }
  /** Sends a queued message now, stopping the running turn. */
  | { type: "sendQueuedNow"; tab: number; id: number }
  /** Takes a message out of the queue; with `edit`, it goes back to the composer ("loadComposer"). */
  | { type: "unqueue"; tab: number; id: number; edit: boolean }
  /** Puts the user message of `turn` back in the composer to change it and send it again ("loadComposer"). */
  | { type: "editMessage"; tab: number; turn: number }
  /** Sends the user message of `turn` again, dropping the conversation after it. */
  | { type: "retry"; tab: number; turn: number }
  /** Copies the conversation into a new tab; with `turn`, only what came before that user message. */
  | { type: "fork"; tab: number; turn?: number }
  | { type: "cancel"; tab: number }
  | { type: "newTab" }
  | { type: "selectTab"; tab: number }
  | { type: "closeTab"; tab: number }
  | { type: "pinTab"; tab: number; pinned: boolean }
  /** A name the user gave the tab, shown over its title; an empty one shows the title again. */
  | { type: "renameTab"; tab: number; title: string }
  /** `index` is the tab's position after the move; it stays inside its pinned or unpinned group. */
  | { type: "moveTab"; tab: number; index: number }
  /** The composer's unsent content, kept so it survives a reload. */
  | { type: "draft"; tab: number; draft: Draft }
  /** The draft's text alone, when its attachments are the ones last sent with "draft". */
  | { type: "draftText"; tab: number; text: string }
  | { type: "history" }
  | { type: "openSession"; sessionId: string; cwd: string; title?: string }
  | { type: "login" }
  | { type: "selectAgent" }
  | { type: "setAgent"; tab: number; id: string }
  /** Moves `tab` to another workspace folder; it starts over in a fresh session there. */
  | { type: "setCwd"; tab: number; cwd: string }
  | { type: "manageAgents" }
  | { type: "permission"; id: number; optionId: string | null }
  | { type: "setConfig"; tab: number; configId: string; value: string }
  /** A file path from agent output; relative paths resolve against the tab's folder. `line` is 1-based. */
  | { type: "openFile"; path: string; line?: number }
  /** An image from the lightbox (a data URI), to open in a window of its own. */
  | { type: "openImage"; src: string; name: string }
  /** Workspace files matching what follows "@"; answered with "files" carrying the same `id`. */
  | { type: "searchFiles"; id: number; query: string }
  /** Skills for "$"; answered with "skills". */
  | { type: "listSkills" }
  /** A terminal command offered with the files; answered with "addAttachments". */
  | { type: "attachTerminal"; id: number }
  /** Stops the command running in one of the agent's terminals. */
  | { type: "killTerminal"; tab: number; terminalId: string }
  /**
   * Opens a diff of what the agent changed in `path`; the tool call's texts are used when the change was not
   * written through the client.
   */
  | { type: "openDiff"; tab: number; path: string; oldText?: string | null; newText?: string }
  /** Accepts the agent's changes to `path`, or to every changed file. */
  | { type: "keepChanges"; tab: number; path?: string }
  /** Puts back what `path` held before the agent changed it, or every changed file. */
  | { type: "undoChanges"; tab: number; path?: string }
  /** Puts the work tree back as it was before the user message of `turn`. */
  | { type: "restoreCheckpoint"; tab: number; turn: number }
  /** Picks a checkpoint of the tab to restore, from a quick pick. */
  | { type: "setFollowAgent"; enabled: boolean };

/** The changed files of a tab, and the turns whose checkpoint differs from the work tree. */
export interface ChangesMessage {
  files: ChangedFile[];
  turns: number[];
}

/** A message waiting for the running turn to end ("queue" message). */
export interface QueuedInfo {
  id: number;
  text: string;
  /** Names of the attachments not inline in the text. */
  attachments: string[];
}

/** The composer content to put back ("loadComposer"): a queued message, or a sent one to edit (with `rewind`). */
export interface LoadComposer {
  parts: PromptPart[];
  /** The turn whose user message is being edited. */
  rewind?: number;
}

/** The workspace folders a tab can run in ("folders" message); the picker shows when there are several. */
export interface WorkspaceFolderInfo {
  name: string;
  path: string;
}

/** A chat tab as the webview shows it in the tab strip. */
export interface TabInfo {
  id: number;
  /** The user's name for the tab, else its title; undefined until the first message or the agent names the session. */
  title?: string;
  pinned: boolean;
  /** When the conversation started (epoch ms); undefined until the first message, or for sessions opened from history. */
  createdAt?: number;
  /** The installed agent picked for the tab; undefined until it has one. */
  agentId?: string;
  /** The folder the tab's session runs in. */
  cwd: string;
  /** The tab's agent can fork its session (session/fork). */
  canFork: boolean;
  /** Unsent composer content; the webview only uses it for tabs it has no draft for yet. */
  draft?: Draft;
}

/** What the composer holds before sending: text, the attachments placed in it as tokens, and the others. */
export interface Draft {
  text: string;
  inline: { token: string; attachment: Attachment }[];
  attachments: Attachment[];
}

/** Something dropped or pasted into the composer. */
export type Attachment =
  /** A file or folder the webview only knows by URI (VS Code explorer, editor tabs, uri-list). */
  | { kind: "uri"; uri: string; name: string }
  /** Raw bytes (OS drop or clipboard), base64-encoded. */
  | { kind: "data"; name: string; mimeType: string; data: string }
  /** Lines selected in an editor; `startLine`/`endLine` are 1-based and inclusive. */
  | { kind: "snippet"; uri: string; name: string; languageId: string; startLine: number; endLine: number; text: string }
  /** Terminal text: a command's output, or a selection (no `commandLine`). */
  | { kind: "terminal"; name: string; terminal: string; shell?: string; commandLine?: string; cwd?: string; exitCode?: number; text: string };

/** A text run of the composer, or an attachment; inline ones carry the `token` that stands for them in the text. */
export type PromptPart = string | (Attachment & { token?: string });

/** An attachment as echoed in the sent message; `src` is a data URI when it went out as an image. */
export interface SentAttachment {
  name: string;
  src?: string;
  /** Set when the attachment sits inline in the message text. */
  token?: string;
}
