import { Option, Schema, Scope, Semaphore } from "effect";
import type { AcpAgent } from "../acpClient";
import { ChangeSet, SavedChanges } from "../fileChanges";
import type { MessageKey } from "../i18n";
import { SavedDraft, type DraftHolder } from "./drafts";
import type { TabInfo } from "./protocol";

export interface RunningAgent {
  readonly agent: AcpAgent;
  /** Owns the agent process; closing it kills the process. */
  readonly scope: Scope.Closeable;
  /** Id of the agent the process was started from, installed or custom. */
  readonly agentId: string;
}

/** A session to reopen when its tab is first used: saved before a reload, or lost when the agent exited. */
export interface Reopen {
  readonly sessionId: string;
  readonly cwd: string;
  /** The agent the session belongs to; another agent can't open it. */
  readonly agentId: string | undefined;
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

export const SavedTabs = Schema.Struct({
  active: Schema.Int,
  tabs: Schema.Array(
    Schema.Struct({
      title: Schema.optional(Schema.String),
      createdAt: Schema.optional(Schema.Finite),
      sessionId: Schema.optional(Schema.String),
      cwd: Schema.optional(Schema.String),
      agentId: Schema.optional(Schema.String),
      usage: Schema.optional(SavedUsage),
      pinned: Schema.optional(Schema.Boolean),
      draft: Schema.optional(SavedDraft),
      changes: Schema.optional(SavedChanges),
    }),
  ),
});
export type SavedTabs = typeof SavedTabs.Type;

/** One conversation: an ACP session on its agent's process; tabs on the same agent share the process. */
export interface Tab extends DraftHolder {
  readonly id: number;
  title?: string;
  /** Epoch ms of the first message sent in the session; reset with `title`. */
  createdAt?: number;
  sessionId?: string;
  /** The process that owns `sessionId`. */
  running?: RunningAgent;
  /** The folder the tab's session runs in: picked for the tab, or the one of the session it opened. */
  cwd: string;
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
  /** Pending `postChanges`. */
  changesTimer?: ReturnType<typeof setTimeout>;
}

/** Forgets the tab's conversation: it starts over in a fresh session when next used. */
export function resetConversation(tab: Tab): void {
  tab.sessionId = undefined;
  tab.running = undefined;
  tab.busy = false;
  tab.used = false;
  tab.title = undefined;
  tab.createdAt = undefined;
  tab.reopen = undefined;
}

/** The usage saved for `sessionId`, if the tab's last report was about it. */
export function usageOf(tab: Tab, sessionId: string): SavedUsage | undefined {
  return tab.usageSessionId === sessionId ? tab.usage : undefined;
}

/** The chat tabs in strip order, and the active one. */
export class TabList {
  private nextId = 1;
  private readonly tabs: Tab[] = [];
  active: Tab;

  /** Recreates the tabs saved for the workspace (`saved` is untrusted); their sessions reopen when first used. */
  constructor(saved: unknown, defaultCwd: () => string) {
    const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(SavedTabs)(saved));
    for (const entry of decoded?.tabs ?? []) {
      const tab = this.add(entry.cwd ?? defaultCwd());
      tab.pinned = entry.pinned ?? false;
      tab.savedDraft = entry.draft;
      tab.agentId = entry.agentId;
      tab.changes = ChangeSet.fromSaved(entry.changes);
      if (entry.sessionId) {
        tab.title = entry.title;
        tab.createdAt = entry.createdAt;
        tab.used = true;
        tab.reopen = { sessionId: entry.sessionId, cwd: tab.cwd, agentId: entry.agentId };
        tab.usage = entry.usage;
        tab.usageSessionId = entry.sessionId;
      }
    }
    this.active = this.tabs[decoded?.active ?? 0] ?? this.tabs[0] ?? this.add(defaultCwd());
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
    };
    this.tabs.push(tab);
    return tab;
  }

  /** Removes `tab`; returns where it was, or -1 when it was already gone. */
  remove(tab: Tab): number {
    const index = this.tabs.indexOf(tab);
    if (index >= 0) {
      this.tabs.splice(index, 1);
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

  /** Moves `tab` to `index`, kept inside its group: pinned tabs stay before the others. False if it is gone. */
  move(tab: Tab, index: number): boolean {
    const from = this.tabs.indexOf(tab);
    if (from < 0) {
      return false;
    }
    this.tabs.splice(from, 1);
    const pinnedCount = this.tabs.filter((each) => each.pinned).length;
    const [min, max] = tab.pinned ? [0, pinnedCount] : [pinnedCount, this.tabs.length];
    this.tabs.splice(Math.min(Math.max(index, min), max), 0, tab);
    return true;
  }

  /** Pinning appends to the pinned group; unpinning puts the tab first among the others. False if nothing changed. */
  pin(tab: Tab, pinned: boolean): boolean {
    if (tab.pinned === pinned) {
      return false;
    }
    tab.pinned = pinned;
    return this.move(tab, this.tabs.filter((each) => each.pinned && each !== tab).length);
  }

  /** The highest turn id in the saved checkpoints, so new turns don't reuse one. */
  get lastTurn(): number {
    return Math.max(0, ...this.tabs.flatMap((tab) => tab.changes.checkpoints.map((c) => c.turn)));
  }

  /** The strip as the webview shows it. */
  get info(): TabInfo[] {
    return this.tabs.map((tab) => ({
      id: tab.id,
      title: tab.title,
      createdAt: tab.createdAt,
      pinned: tab.pinned,
      agentId: tab.agentId,
      cwd: tab.cwd,
      draft: tab.draft,
    }));
  }

  /** The tabs as saved in workspaceState. */
  get saved(): SavedTabs {
    return {
      active: this.tabs.indexOf(this.active),
      tabs: this.tabs.map((tab) => {
        const { pinned, savedDraft: draft, title, createdAt } = tab;
        const changes = tab.changes.saved;
        // An unused tab's session is empty: a fresh one is just as good.
        if (tab.sessionId && tab.used) {
          const { sessionId, cwd } = tab;
          const agentId = tab.running?.agentId;
          return { title, createdAt, sessionId, cwd, agentId, usage: usageOf(tab, sessionId), pinned, draft, changes };
        }
        if (tab.reopen) {
          const { sessionId, cwd, agentId } = tab.reopen;
          return { title, createdAt, sessionId, cwd, agentId, usage: usageOf(tab, sessionId), pinned, draft, changes };
        }
        return { cwd: tab.cwd, pinned, agentId: tab.agentId, draft, changes };
      }),
    };
  }
}
