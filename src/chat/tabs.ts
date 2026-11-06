import type * as acp from "@agentclientprotocol/sdk";
import type { TurnStats } from "./trace";
import { Option, Schema, Scope, Semaphore } from "effect";
import { canFork, type AcpAgent } from "../acpClient";
import { ChangeSet, SavedChanges } from "../fileChanges";
import type { MessageKey } from "../i18n";
import { isManaged, TabWorktree, WorktreeSettled } from "../worktrees";
import { SavedDraft, type DraftHolder } from "./drafts";
import type { Attempt, PromptPart, TabGroupInfo, TabInfo } from "./protocol";
import { TurnTraces } from "./turnTraces";

export interface RunningAgent {
  readonly agent: AcpAgent;
  /** Owns the agent process; closing it kills the process. */
  readonly scope: Scope.Closeable;
  /** Id of the agent the process was started from, installed or custom. */
  readonly agentId: string;
}

/** A session to reopen when its tab is next used: saved before a reload, or lost when the agent stopped or wanted a login. */
export interface Reopen {
  readonly sessionId: string;
  readonly cwd: string;
  /** The agent the session belongs to; another agent can't open it. */
  readonly agentId: string | undefined;
}

/** A message as the composer sent it, kept to queue it, or to edit and send it again. */
export interface OutgoingMessage {
  readonly parts: ReadonlyArray<PromptPart>;
}

export interface QueuedMessage extends OutgoingMessage {
  readonly id: number;
}

/** The composer text of a message, with its inline attachments as their tokens. */
export function messageText(parts: ReadonlyArray<PromptPart>): string {
  return parts.map((part) => (typeof part === "string" ? part : (part.token ?? ""))).join("");
}

/** Last context usage reported for a session; agents report none when a session is loaded. */
export const SavedUsage = Schema.Struct({
  used: Schema.Finite,
  size: Schema.Finite,
  cost: Schema.optional(Schema.NullOr(Schema.Struct({ amount: Schema.Finite, currency: Schema.String }))),
  /** Auto-compact window, when the agent compacts before the end of `size`. */
  compactAt: Schema.optional(Schema.Finite),
});
export type SavedUsage = typeof SavedUsage.Type;

const SavedTabGroup = Schema.Struct({
  id: Schema.Int,
  title: Schema.String,
  name: Schema.optional(Schema.String),
  prompt: Schema.String,
  createdAt: Schema.Finite,
  collapsed: Schema.optional(Schema.Boolean),
});

/** The model and effort a comparison picked for a tab; empty ones are left to what its agent's sessions usually start with. */
const SavedWanted = Schema.Struct({ model: Schema.String, effort: Schema.String });

export const SavedTabs = Schema.Struct({
  active: Schema.Int,
  groups: Schema.optional(Schema.Array(SavedTabGroup)),
  /** The group whose comparison the view shows, instead of the active tab. */
  shownGroup: Schema.optional(Schema.Int),
  tabs: Schema.Array(
    Schema.Struct({
      title: Schema.optional(Schema.String),
      createdAt: Schema.optional(Schema.Finite),
      sessionId: Schema.optional(Schema.String),
      cwd: Schema.optional(Schema.String),
      agentId: Schema.optional(Schema.String),
      usage: Schema.optional(SavedUsage),
      pinned: Schema.optional(Schema.Boolean),
      name: Schema.optional(Schema.String),
      draft: Schema.optional(SavedDraft),
      changes: Schema.optional(SavedChanges),
      /** Decoded by TurnTraces. */
      traces: Schema.optional(Schema.Unknown),
      worktree: Schema.optional(TabWorktree),
      worktreeOnSend: Schema.optional(Schema.Boolean),
      group: Schema.optional(Schema.Int),
      applied: Schema.optional(Schema.Boolean),
      settled: Schema.optional(WorktreeSettled),
      wanted: Schema.optional(SavedWanted),
      attemptLabel: Schema.optional(Schema.String),
    }),
  ),
});
export type SavedTabs = typeof SavedTabs.Type;

/** The tabs that got one prompt, each with an agent of its own in a worktree of its own (Best of N). */
export interface TabGroup {
  readonly id: number;
  /** From the prompt. */
  readonly title: string;
  /** The name the user gave the group; shown instead of `title`. */
  name?: string;
  /** The prompt's text. */
  readonly prompt: string;
  /** Epoch ms. */
  readonly createdAt: number;
  /** Its tabs are left out of the sidebar. */
  collapsed: boolean;
}

/** One conversation: an ACP session on its agent's process; tabs on the same agent share the process. */
export interface Tab extends DraftHolder {
  readonly id: number;
  title?: string;
  /** The name the user gave the tab; shown instead of `title`, which the agent keeps updating. */
  name?: string;
  /** Epoch ms of the first message sent in the session; reset with `title`. */
  createdAt?: number;
  sessionId?: string;
  /** The process that owns `sessionId`. */
  running?: RunningAgent;
  /** The session's config options as the agent last reported them; the status bar shows the model. */
  configOptions?: ReadonlyArray<acp.SessionConfigOption>;
  /** The folder the tab's session runs in: picked for the tab, or the one of the session it opened. */
  cwd: string;
  /** The git worktree `cwd` is in, when the tab has one of its own. */
  worktree?: TabWorktree;
  /** What is checked out in `cwd`, as last read. */
  branch?: string;
  /** Its session starts in a new worktree. */
  wantsWorktree?: boolean;
  /** The name of that worktree's branch, when it is known by then. */
  worktreeName?: string;
  /** Its Worktree box is ticked, by the user or codeAcp.worktreeForNewTabs: the next message moves it to a new worktree. */
  worktreeOnSend?: boolean;
  /** The agent picked for the tab, installed or custom. */
  agentId?: string;
  reopen?: Reopen;
  /** Last usage of the session `usageSessionId`, shown again when that session is reloaded. */
  usage?: SavedUsage;
  usageSessionId?: string;
  busy: boolean;
  /** Set while a send prepares its prompt, before `busy`; a second click in that time is dropped. */
  sending: boolean;
  /** Pinned tabs come first and have no close button. */
  pinned: boolean;
  /** Whether anything was sent or loaded; an unused tab is reused to open a past session. */
  used: boolean;
  /** Makes concurrent callers share one session start. */
  readonly sessionLock: Semaphore.Semaphore;
  /** Last status shown, re-posted in the new language when the locale changes. */
  lastStatus?: { key: MessageKey; extra: Record<string, unknown> };
  /** Checkpoints of the work tree and the changes since the last review. */
  changes: ChangeSet;
  /** The turn being run; its user message carries the id. */
  turn?: number;
  /** What the running turn did so far, for codeAcp.tracing. */
  turnStats?: TurnStats;
  /** The numbers of the session's finished turns, for codeAcp.tracing. */
  traces: TurnTraces;
  /** Messages sent while a turn ran, sent in order as each turn ends. */
  queue: QueuedMessage[];
  /** The running turn was stopped to send the first queued message right away. */
  steer: boolean;
  /** The messages sent from this chat, by turn, so they can be edited or sent again. */
  sent: Map<number, OutgoingMessage>;
  /** Tells the agent, with the next prompt, which messages the user took back. */
  rewindNote?: string;
  /** While session/load replays the history: the user message being replayed, kept in `sent` by its turn. */
  replaying?: { turn?: number; blocks: acp.ContentBlock[]; turns: number[] };
  /** The group the tab belongs to; a group's tabs stay next to each other. */
  group?: TabGroup;
  /** How the prompt of its group went, while this session knows. */
  attempt?: Attempt;
  /** Its worktree's changes were applied to the base folder. */
  applied?: boolean;
  /** Its worktree holds work that hasn't gone anywhere yet, as last read. */
  finishable?: boolean;
  /** Where the work of its worktree went. */
  settled?: WorktreeSettled;
  /** The merge of its worktree's branch while that has conflicts, as last read: what the branch is being merged into. */
  conflict?: { readonly root: string; readonly target: string };
  /** What the agent has said in the running turn since its last tool call, when the turn's reply is wanted. */
  reply?: { text: string };
  /** The model and effort its sessions start with, over those usual for the agent: what its group's comparison picked. */
  wanted?: typeof SavedWanted.Type;
  /** `wanted` by name. */
  attemptLabel?: string;
  /** Pending `postChanges`. */
  changesTimer?: ReturnType<typeof setTimeout>;
}

/** Takes the tab off its process, which is gone or going; a session in use is kept to reopen, and the queue waits for it. */
export function detachSession(tab: Tab): void {
  if (tab.running && tab.sessionId && tab.used) {
    tab.reopen = { sessionId: tab.sessionId, cwd: tab.cwd, agentId: tab.running.agentId };
  }
  tab.sessionId = undefined;
  tab.running = undefined;
  tab.configOptions = undefined;
  tab.busy = false;
  tab.steer = false;
}

/** Forgets the tab's conversation: it starts over in a fresh session when next used. */
export function resetConversation(tab: Tab): void {
  tab.sessionId = undefined;
  tab.running = undefined;
  tab.configOptions = undefined;
  tab.busy = false;
  tab.used = false;
  tab.title = undefined;
  tab.createdAt = undefined;
  tab.reopen = undefined;
  tab.queue = [];
  tab.steer = false;
  tab.sent.clear();
  tab.rewindNote = undefined;
  tab.wanted = undefined;
  tab.attemptLabel = undefined;
}

/** The usage saved for `sessionId`, if the tab's last report was about it. */
export function usageOf(tab: Tab, sessionId: string): SavedUsage | undefined {
  return tab.usageSessionId === sessionId ? tab.usage : undefined;
}

/** The chat tabs in strip order, and the active one. */
export class TabList {
  private nextId = 1;
  private readonly tabs: Tab[] = [];
  private readonly tabGroups: TabGroup[] = [];
  private nextGroupId = 1;
  private activeTab: Tab;
  /** The group whose comparison the view shows, instead of the active tab; choosing a tab ends that. */
  private shown: TabGroup | undefined;

  /** Recreates the tabs saved for the workspace (`saved` is untrusted); their sessions reopen when first used. */
  constructor(saved: unknown, defaultCwd: () => string) {
    const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(SavedTabs)(saved));
    const groups = new Map(
      (decoded?.groups ?? []).map((group) => [group.id, { ...group, collapsed: group.collapsed ?? false }]),
    );
    for (const entry of decoded?.tabs ?? []) {
      const tab = this.add(entry.cwd ?? defaultCwd());
      tab.pinned = entry.pinned ?? false;
      tab.name = entry.name;
      tab.savedDraft = entry.draft;
      tab.agentId = entry.agentId;
      tab.changes = ChangeSet.fromSaved(entry.changes);
      tab.worktree = entry.worktree;
      tab.worktreeOnSend = entry.worktreeOnSend;
      tab.group = entry.group === undefined ? undefined : groups.get(entry.group);
      tab.applied = entry.applied;
      tab.settled = entry.settled;
      tab.wanted = entry.wanted;
      tab.attemptLabel = entry.attemptLabel;
      if (entry.sessionId) {
        tab.title = entry.title;
        tab.createdAt = entry.createdAt;
        tab.used = true;
        tab.reopen = { sessionId: entry.sessionId, cwd: tab.cwd, agentId: entry.agentId };
        tab.usage = entry.usage;
        tab.usageSessionId = entry.sessionId;
        tab.traces = TurnTraces.fromSaved(entry.traces);
      }
    }
    const active = this.tabs[decoded?.active ?? 0];
    this.keepGroupsTogether();
    this.activeTab = active ?? this.tabs[0] ?? this.add(defaultCwd());
    this.tabGroups.push(...[...groups.values()].filter((group) => this.tabs.some((tab) => tab.group === group)));
    this.nextGroupId = Math.max(0, ...this.tabGroups.map((group) => group.id)) + 1;
    this.shown = this.tabGroups.find((group) => group.id === decoded?.shownGroup);
  }

  /** Saved tabs are untrusted: puts each group's tabs where its first one is, pinned as that one is. */
  private keepGroupsTogether(): void {
    const ordered = this.tabs.flatMap((tab) => {
      if (tab.group === undefined) {
        return [tab];
      }
      const members = this.members(tab.group);
      return members[0] === tab ? members : [];
    });
    this.tabs.splice(0, this.tabs.length, ...ordered);
    for (const tab of this.tabs) {
      if (tab.group) {
        tab.pinned = this.members(tab.group)[0]!.pinned;
      }
    }
  }

  get active(): Tab {
    return this.activeTab;
  }

  set active(tab: Tab) {
    this.activeTab = tab;
    this.shown = undefined;
  }

  get shownGroup(): TabGroup | undefined {
    return this.shown;
  }

  /** Shows the group's comparison; the active tab stays what the rest of the extension talks about. */
  showGroup(group: TabGroup): void {
    this.shown = group;
  }

  get groups(): ReadonlyArray<TabGroup> {
    return this.tabGroups;
  }

  groupById(id: number): TabGroup | undefined {
    return this.tabGroups.find((group) => group.id === id);
  }

  addGroup(title: string, prompt: string): TabGroup {
    const group: TabGroup = { id: this.nextGroupId++, title, prompt, createdAt: Date.now(), collapsed: false };
    this.tabGroups.push(group);
    return group;
  }

  /** The tabs of `group`, in order. */
  members(group: TabGroup): ReadonlyArray<Tab> {
    return this.tabs.filter((tab) => tab.group === group);
  }

  get all(): ReadonlyArray<Tab> {
    return this.tabs;
  }

  get length(): number {
    return this.tabs.length;
  }

  add(cwd: string): Tab {
    const tab: Tab = {
      id: this.nextId++,
      cwd,
      busy: false,
      sending: false,
      pinned: false,
      used: false,
      sessionLock: Semaphore.makeUnsafe(1),
      changes: new ChangeSet(),
      traces: new TurnTraces(),
      queue: [],
      steer: false,
      sent: new Map(),
    };
    this.tabs.push(tab);
    return tab;
  }

  /** Removes `tab`; returns where it was, or -1 when it was already gone. */
  remove(tab: Tab): number {
    const index = this.tabs.indexOf(tab);
    if (index < 0) {
      return index;
    }
    this.tabs.splice(index, 1);
    // A group lasts as long as it has tabs.
    if (tab.group && this.members(tab.group).length === 0) {
      this.tabGroups.splice(this.tabGroups.indexOf(tab.group), 1);
      if (this.shown === tab.group) {
        this.shown = undefined;
      }
    }
    return index;
  }

  /** Whether `tab` is still open; a closed tab's turn may still be winding down. */
  has(tab: Tab): boolean {
    return this.tabs.includes(tab);
  }

  indexOf(tab: Tab): number {
    return this.tabs.indexOf(tab);
  }

  at(index: number): Tab | undefined {
    return this.tabs[index];
  }

  byId(id: number): Tab | undefined {
    return this.tabs.find((tab) => tab.id === id);
  }

  forSession(running: RunningAgent, sessionId: string): Tab | undefined {
    return this.tabs.find((tab) => tab.running === running && tab.sessionId === sessionId);
  }

  /** The open tab showing `sessionId`, or about to reopen it. */
  showing(sessionId: string): Tab | undefined {
    return this.tabs.find((tab) => tab.sessionId === sessionId || tab.reopen?.sessionId === sessionId);
  }

  /** Puts `moved`, next to each other, at `index` of the tabs left: pinned tabs stay first, and no group gets split. */
  private place(moved: ReadonlyArray<Tab>, index: number): void {
    const rest = this.tabs.filter((tab) => !moved.includes(tab));
    const pinnedCount = rest.filter((each) => each.pinned).length;
    const [min, max] = moved[0]!.pinned ? [0, pinnedCount] : [pinnedCount, rest.length];
    let at = Math.min(Math.max(index, min), max);
    while (at > 0 && at < rest.length && rest[at - 1]!.group !== undefined && rest[at - 1]!.group === rest[at]!.group) {
      at++;
    }
    rest.splice(at, 0, ...moved);
    this.tabs.splice(0, this.tabs.length, ...rest);
  }

  /**
   * Moves `tab` to `index`. It stays with the others of its kind: pinned tabs before the rest, a group's tabs inside
   * their group. False if it is gone.
   */
  move(tab: Tab, index: number): boolean {
    const from = this.tabs.indexOf(tab);
    if (from < 0) {
      return false;
    }
    if (tab.group) {
      const first = this.tabs.indexOf(this.members(tab.group)[0]!);
      const last = first + this.members(tab.group).length - 1;
      this.tabs.splice(from, 1);
      this.tabs.splice(Math.min(Math.max(index, first), last), 0, tab);
      return true;
    }
    this.place([tab], index);
    return true;
  }

  /** Moves the tabs of `group`, so that the first ends up at `index`. */
  moveGroup(group: TabGroup, index: number): void {
    const members = this.members(group);
    if (members.length > 0) {
      this.place(members, index);
    }
  }

  /**
   * Pinning appends to the pinned tabs; unpinning puts the tab first among the others. A group's tabs go together, as
   * pinned tabs come first and it would come apart. False if nothing changed.
   */
  pin(tab: Tab, pinned: boolean): boolean {
    if (tab.pinned === pinned) {
      return false;
    }
    const moved = tab.group ? this.members(tab.group) : [tab];
    for (const each of moved) {
      each.pinned = pinned;
    }
    this.place(moved, this.tabs.filter((each) => each.pinned && !moved.includes(each)).length);
    return true;
  }

  /** Names `tab` as the user typed it; an empty name shows its title again. False if nothing changed. */
  rename(tab: Tab, name: string): boolean {
    const trimmed = name.trim() || undefined;
    if (tab.name === trimmed) {
      return false;
    }
    tab.name = trimmed;
    return true;
  }

  /** The highest turn id in the saved checkpoints, so new turns don't reuse one. */
  get lastTurn(): number {
    return Math.max(0, ...this.tabs.flatMap((tab) => tab.changes.checkpoints.map((c) => c.turn)));
  }

  /** The strip as the webview shows it. */
  get info(): TabInfo[] {
    return this.tabs.map((tab) => ({
      id: tab.id,
      title: tab.name ?? tab.title,
      named: tab.name !== undefined,
      createdAt: tab.createdAt,
      pinned: tab.pinned,
      sessionId: tab.sessionId ?? tab.reopen?.sessionId,
      agentId: tab.agentId,
      cwd: tab.cwd,
      worktree: tab.worktree,
      worktreeOnSend: tab.worktreeOnSend,
      branch: tab.branch,
      used: tab.used,
      canFork: !!tab.sessionId && !!tab.running && canFork(tab.running.agent),
      draft: tab.draft,
      group: tab.group?.id,
      attempt: tab.attempt,
      attemptLabel: tab.attemptLabel,
      applied: tab.applied,
      finishable: tab.finishable,
      settled: tab.settled?.root === tab.worktree?.root ? tab.settled : undefined,
      conflict: tab.conflict?.root === tab.worktree?.root ? tab.conflict?.target : undefined,
      deletable:
        tab.worktree !== undefined &&
        isManaged(tab.worktree.root) &&
        !this.all.some((other) => other !== tab && other.worktree?.root === tab.worktree?.root),
    }));
  }

  /** The groups as the webview shows them. */
  get groupsInfo(): TabGroupInfo[] {
    return this.tabGroups.map((group) => ({
      id: group.id,
      title: group.name ?? group.title,
      prompt: group.prompt,
      createdAt: group.createdAt,
      collapsed: group.collapsed,
    }));
  }

  /** The tabs as saved in workspaceState. */
  get saved(): SavedTabs {
    return {
      active: this.tabs.indexOf(this.active),
      groups: this.tabGroups.map(({ id, title, name, prompt, createdAt, collapsed }) => ({
        id,
        title,
        name,
        prompt,
        createdAt,
        collapsed,
      })),
      shownGroup: this.shown?.id,
      tabs: this.tabs.map((tab) => {
        const {
          pinned,
          name,
          savedDraft: draft,
          title,
          createdAt,
          worktree,
          worktreeOnSend,
          applied,
          settled,
          wanted,
          attemptLabel,
        } = tab;
        const changes = tab.changes.saved;
        const group = tab.group?.id;
        // An unused tab's session is empty: a fresh one is just as good.
        if (tab.sessionId && tab.used) {
          const { sessionId, cwd } = tab;
          const agentId = tab.running?.agentId;
          return {
            title,
            createdAt,
            sessionId,
            cwd,
            agentId,
            usage: usageOf(tab, sessionId),
            pinned,
            name,
            draft,
            changes,
            traces: tab.traces.saved,
            worktree,
            worktreeOnSend,
            group,
            applied,
            settled,
            wanted,
            attemptLabel,
          };
        }
        if (tab.reopen) {
          const { sessionId, cwd, agentId } = tab.reopen;
          return {
            title,
            createdAt,
            sessionId,
            cwd,
            agentId,
            usage: usageOf(tab, sessionId),
            pinned,
            name,
            draft,
            changes,
            traces: tab.traces.saved,
            worktree,
            worktreeOnSend,
            group,
            applied,
            settled,
            wanted,
            attemptLabel,
          };
        }
        return {
          cwd: tab.cwd,
          pinned,
          name,
          agentId: tab.agentId,
          draft,
          changes,
          worktree,
          worktreeOnSend,
          group,
          applied,
          settled,
          wanted,
          attemptLabel,
        };
      }),
    };
  }
}
