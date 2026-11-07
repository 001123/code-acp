// Messages and shapes shared by the chat view's host (src/chat/*) and its webview (src/ui/chat/*).
import type { CatalogMessage } from "../agentCatalog";
import type { TerminalSnapshot } from "../agentTerminals";
import type { DoctorMessage } from "../doctor";
import type { ChangedFile } from "../fileChanges";
import type { ProblemScope } from "../problems";
import type { ChangeBlock } from "../ui/lineDiff";
import type { TabWorktree, WorktreeFileDiff, WorktreeSettled } from "../worktrees";
import type { TurnTrace } from "./turnTraces";

/** One change in a file, to keep or undo on its own. */
export type ChangeHunk = ChangeBlock;

export type { ChangedFile, TerminalSnapshot, TurnTrace, WorktreeFileDiff, WorktreeSettled };

export type FromWebview =
  | { type: "ready" }
  /**
   * The composer in order: text runs and the attachments between them. While the tab is busy it is queued, or with
   * `now` sent right away, stopping the turn. With `rewind`, it replaces the user message of that turn and the rest
   * of the conversation after it.
   */
  | { type: "send"; tab: number; parts: PromptPart[]; now?: boolean; rewind?: number }
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
  /** Closes the unpinned tabs at rest, keeping their conversations in the history. */
  | { type: "archiveTabs" }
  /** Sends the composer's content to each of `attempts`, in a new tab and worktree of a new group ("loadComposer" if not). */
  | { type: "bestOf"; tab: number; parts: PromptPart[]; attempts: AttemptPick[] }
  /** What agent `agentId` offers for a comparison, with the efforts of `model`; answered with "attemptOptions". */
  | { type: "loadAttemptOptions"; agentId: string; model: string }
  /** Shows the comparison of a group's tabs. */
  | { type: "selectGroup"; group: number }
  | { type: "closeGroup"; group: number }
  /** Closes the group and deletes its worktrees, after asking if that loses anything. */
  | { type: "discardGroup"; group: number }
  /** An empty name shows the group's title again. */
  | { type: "renameGroup"; group: number; title: string }
  /** `index` is where the group's first tab ends up. */
  | { type: "moveGroup"; group: number; index: number }
  | { type: "collapseGroup"; group: number; collapsed: boolean }
  /** Counts what the tabs of the group changed again; answered with "worktreeDiff" for each. */
  | { type: "refreshGroup"; group: number }
  /** Applies what the tab's worktree holds to its base folder, after asking. */
  | { type: "applyWorktree"; tab: number }
  /** Opens a diff of `path` (from the top of the tab's worktree) against the commit the worktree forked off. */
  | { type: "openWorktreeDiff"; tab: number; path: string }
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
  /** Lists the conversations for the sidebar; answered with "history". */
  | { type: "history" }
  | { type: "openSession"; sessionId: string; cwd: string; title?: string }
  /** Deletes a past session, after asking; answered with "sessionDeleted". */
  | { type: "deleteSession"; sessionId: string; title?: string }
  | { type: "login" }
  | { type: "selectAgent" }
  | { type: "setAgent"; tab: number; id: string }
  /** Moves `tab` to another workspace folder; it starts over in a fresh session there. */
  | { type: "setCwd"; tab: number; cwd: string }
  /** Offers the worktrees `tab` can run in, and what can be done with its own. */
  | { type: "pickWorktree"; tab: number }
  /** Has the tab's next message move it to a new worktree, or not any more. */
  | { type: "toggleWorktree"; tab: number }
  /** Offers the ways to finish the work in the tab's worktree. */
  | { type: "finishWorktree"; tab: number }
  /** Deletes the tab's worktree, going back to its base folder, after asking. */
  | { type: "deleteWorktree"; tab: number }
  /** Reads again what state the tab's worktree is in: a merge's conflicts get solved outside the chat. */
  | { type: "refreshWorktree"; tab: number }
  /** Gives up the merge of the tab's worktree, after asking. */
  | { type: "abortWorktreeMerge"; tab: number }
  /** Shows the conflicts of the merge of the tab's worktree. */
  | { type: "showWorktreeConflicts"; tab: number }
  /** Opens the pull request the work of the tab's worktree went to. */
  | { type: "openWorktreePr"; tab: number }
  /** Pushes the branch of the tab's worktree and opens the pull request of its "prDraft". */
  | { type: "createPr"; tab: number; title: string; body: string }
  /** Drops the tab's "prDraft". */
  | { type: "dismissPr"; tab: number }
  | { type: "manageAgents" }
  /** The first-run panel: the registry's agents, answered with "catalog", and installing them. */
  | Extract<CatalogMessage, { type: "catalogLoad" | "catalogRefresh" | "catalogInstall" }>
  /** The first-run panel: checks the tools before offering agents, answered with "doctor", and opens where to get a missing one. */
  | Extract<DoctorMessage, { type: "doctorRun" | "doctorFix" }>
  /** The tab's conversation as Markdown, empty if it has none, to save to a file ("exportConversation" asks for it). */
  | { type: "saveConversation"; tab: number; markdown: string }
  /** Opens the usage summary (clicking the context meter). */
  | { type: "showUsage" }
  /** Opens the log of the messages exchanged with agents. */
  | { type: "showTrace" }
  | { type: "openSettings" }
  /** Installs the registry version the agent picker offers for agent `id`. */
  | { type: "updateAgent"; id: string }
  | { type: "permission"; id: number; optionId: string | null }
  /** The user's answer to question `id` ("elicitationRequest"). */
  | { type: "elicitation"; id: number; response: ElicitationAnswer }
  | { type: "setConfig"; tab: number; configId: string; value: string }
  /** A file path from agent output; relative paths resolve against the tab's folder. `line` is 1-based. */
  | { type: "openFile"; path: string; line?: number }
  /** An image from the lightbox (a data URI), to open in a window of its own. */
  | { type: "openImage"; src: string; name: string }
  /** A ```mermaid block's source, to open in an editor tab where it can be zoomed and panned. */
  | { type: "openDiagram"; code: string }
  /** Workspace files matching what follows "@"; answered with "files" carrying the same `id`. */
  | { type: "searchFiles"; id: number; query: string }
  /** Skills for "$"; answered with "skills". */
  | { type: "listSkills" }
  /** A terminal command offered with the files; answered with "addAttachments". */
  | { type: "attachTerminal"; id: number }
  /** Problems offered with the files; answered with "addAttachments". */
  | { type: "attachProblems"; scope: ProblemScope }
  /** Stops the command running in one of the agent's terminals. */
  | { type: "killTerminal"; tab: number; terminalId: string }
  /** Stops one of the tab's background tasks ("backgroundTasks"); the turn, if one runs, goes on. */
  | { type: "stopBackgroundTask"; tab: number; id: string }
  /**
   * Opens a diff of what the agent changed in `path`; the tool call's texts are used when the change was not
   * written through the client. `line` is 1-based.
   */
  | { type: "openDiff"; tab: number; path: string; oldText?: string | null; newText?: string; line?: number }
  /** The changes in `path`, one by one; answered with "hunks". */
  | { type: "listHunks"; tab: number; path: string }
  /** Accepts one change to `path`. */
  | { type: "keepHunk"; tab: number; path: string; hunk: ChangeHunk }
  /** Takes one change out of `path`. */
  | { type: "undoHunk"; tab: number; path: string; hunk: ChangeHunk }
  /** Accepts the agent's changes to `path`, or to every changed file. */
  | { type: "keepChanges"; tab: number; path?: string }
  /** Puts back what `path` held before the agent changed it, or every changed file. */
  | { type: "undoChanges"; tab: number; path?: string }
  /** Puts the work tree back as it was before the user message of `turn`. */
  | { type: "restoreCheckpoint"; tab: number; turn: number }
  | { type: "setFollowAgent"; enabled: boolean }
  | { type: "setAutoScroll"; enabled: boolean }
  | { type: "setTracing"; enabled: boolean }
  | { type: "setShowChanges"; enabled: boolean }
  | { type: "setShowRestore"; enabled: boolean }
  /** Stars a model of agent `agent` in kdCode.providers, or takes its star away. */
  | { type: "toggleFavorite"; agent: string; value: string; name: string }
  /** Favorites the webview kept before they were a setting, to add to kdCode.providers once. */
  | { type: "importFavorites"; favorites: unknown };

/** Messages about one tab. */
export type TabMessage = Extract<FromWebview, { tab: number }>;

/** Messages about one group of tabs. */
export type GroupMessage = Extract<FromWebview, { group: number }>;

/** Messages about the turns of one tab. */
export type TurnMessage = Extract<TabMessage, { type: "send" | "sendQueuedNow" | "unqueue" | "editMessage" | "retry" }>;

/** Messages about the changes of one tab: the review answers them. */
export type ChangeMessage = Extract<
  TabMessage,
  { type: "openDiff" | "listHunks" | "keepHunk" | "undoHunk" | "keepChanges" | "undoChanges" | "restoreCheckpoint" }
>;

/** Messages that don't touch a tab's conversation. */
export type ViewMessage = Extract<
  FromWebview,
  {
    type:
      | "selectAgent"
      | "manageAgents"
      | "showUsage"
      | "showTrace"
      | "openSettings"
      | "permission"
      | "elicitation"
      | "openFile"
      | "openImage"
      | "openDiagram"
      | "searchFiles"
      | "attachProblems"
      | "attachTerminal"
      | "listSkills"
      | "loadAttemptOptions"
      | "setFollowAgent"
      | "setAutoScroll"
      | "setTracing"
      | "setShowChanges"
      | "setShowRestore"
      | "toggleFavorite"
      | "importFavorites";
  }
>;

/**
 * What the user did with a form or link the agent sent: sent the form with the values of its fields or agreed to open
 * the link, declined, or dismissed it (the agent stops what asked).
 */
export type ElicitationAnswer =
  { action: "accept"; content?: Record<string, ElicitationValue> } | { action: "decline" | "cancel" };

export type ElicitationValue = string | number | boolean | string[];

/** The changed files of a tab, and the turns whose checkpoint differs from the work tree. */
export interface ChangesMessage {
  files: ChangedFile[];
  turns: number[];
}

export interface TurnChanges {
  files: number;
  added: number;
  removed: number;
}

/** Work the agent runs in the background of a tab's session, until it ends ("backgroundTasks" message). */
export interface BackgroundTask {
  id: string;
  name: string;
  /** "shell" (a command sent to the background), "monitor", "turn" (the agent works on its own), or another kind. */
  taskType: string;
  description?: string;
  /** What it last reported. */
  summary?: string;
  /** The file its output goes to. */
  outputFilePath?: string;
  /** The tool call that started it. */
  toolCallId?: string;
  canStop: boolean;
  /** Asked to stop, and not ended yet. */
  stopping?: boolean;
}

/** A message waiting for the running turn to end ("queue" message). */
export interface QueuedInfo {
  id: number;
  text: string;
  /** Names of the attachments not inline in the text. */
  attachments: string[];
}

/**
 * The composer content to put back ("loadComposer"): a queued message, one whose turn could not start, or a sent one
 * to edit (with `rewind`).
 */
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

/** How the prompt of a group went in one of its tabs; unknown after a reload. */
export type Attempt = "running" | "done" | "failed";

/** A group of tabs as the webview shows it in the tab sidebar. */
export interface TabGroupInfo {
  id: number;
  /** The user's name for the group, else its title. */
  title: string;
  prompt: string;
  createdAt: number;
  collapsed: boolean;
}

/** A pull request the user is about to open ("prDraft" message); `base` undefined means the repository's default branch. */
export interface PrDraft {
  title: string;
  body: string;
  head: string;
  remote: string;
  base?: string;
  /** Being pushed and opened: the form waits. */
  pending?: boolean;
}

/** What a tab's worktree changed ("worktreeDiff" message); `error` when that couldn't be read. */
export interface WorktreeDiff {
  files: ReadonlyArray<WorktreeFileDiff>;
  error?: string;
}

/** One try of a comparison: an agent, with a model and effort; empty ones are left to what its sessions usually start with. */
export interface AttemptPick {
  agentId: string;
  model: string;
  effort: string;
  /** The model and effort by name, to tell the group's tabs apart. */
  label?: string;
}

/** A chat tab as the webview shows it in the tab sidebar. */
export interface TabInfo {
  id: number;
  /** The user's name for the tab, else its title; undefined until the first message or the agent names the session. */
  title?: string;
  /** `title` is the user's name for the tab. */
  named: boolean;
  /** The group it belongs to; a group's tabs come next to each other. */
  group?: number;
  attempt?: Attempt;
  /** The model and effort its group's comparison picked, by name. */
  attemptLabel?: string;
  /** Its worktree's changes were applied to the base folder. */
  applied?: boolean;
  /** Its worktree holds work that hasn't gone anywhere yet. */
  finishable?: boolean;
  /** Where the work of its worktree went. */
  settled?: WorktreeSettled;
  /** What its worktree's branch is being merged into while that merge has conflicts. */
  conflict?: string;
  /** Its worktree can be deleted: the extension made it and no other tab runs in it. */
  deletable?: boolean;
  pinned: boolean;
  /** The conversation shown in it, also while its agent has yet to reopen it; the history leaves it out. */
  sessionId?: string;
  /** When the conversation started (epoch ms); undefined until the first message, or for sessions opened from history. */
  createdAt?: number;
  /** The installed agent picked for the tab; undefined until it has one. */
  agentId?: string;
  /** The folder the tab's session runs in. */
  cwd: string;
  /** The git worktree `cwd` is in, when the tab has one of its own. */
  worktree?: TabWorktree;
  /** Its next message moves it to a new worktree. */
  worktreeOnSend?: boolean;
  /** What is checked out in `cwd`; undefined outside git. */
  branch?: string;
  /** Something was sent or loaded in it: it has a conversation to keep. */
  used: boolean;
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
  | {
      kind: "terminal";
      name: string;
      terminal: string;
      shell?: string;
      commandLine?: string;
      cwd?: string;
      exitCode?: number;
      text: string;
    }
  /** Problems VS Code reports (errors, warnings), one per line. */
  | { kind: "problems"; name: string; text: string };

/** A text run of the composer, or an attachment; inline ones carry the `token` that stands for them in the text. */
export type PromptPart = string | (Attachment & { token?: string });

/** An attachment as echoed in the sent message; `src` is a data URI when it went out as an image. */
export interface SentAttachment {
  name: string;
  src?: string;
  /** Set when the attachment sits inline in the message text. */
  token?: string;
  /** The local file it came from, which opens on a click. */
  path?: string;
  /** The line the file opens at. */
  line?: number;
}
