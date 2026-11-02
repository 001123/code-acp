import type * as acp from "@agentclientprotocol/sdk";
import { Effect, Exit, Predicate } from "effect";
import * as vscode from "vscode";
import type { AgentRequestError, AgentStartError, AuthRequiredError } from "../acpClient";
import type { ShadowGit } from "../checkpoints";
import { t } from "../i18n";
import type { ExtensionCtx, Output } from "../runtime";
import type { Worktrees } from "../worktrees";
import { attachmentBlock, withActiveFile } from "./attachments";
import type { ChangeReview } from "./changes";
import type { ChatUi } from "./host";
import type { LoadComposer, QueuedInfo, SentAttachment, TurnMessage } from "./protocol";
import { messageText, type OutgoingMessage, type Tab, type TabList } from "./tabs";
import type { TabUsage } from "./usage";
import type { TabWorktrees } from "./worktrees";

const MAX_TITLE_LENGTH = 40;

/** Characters of a taken-back message quoted to the agent. */
const MAX_EXCERPT_LENGTH = 80;

/** What the turns of tabs need from the chat view. */
export interface TurnsHost extends ChatUi {
  readonly tabs: TabList;
  readonly changes: ChangeReview;
  readonly usage: TabUsage;
  readonly tabWorktrees: TabWorktrees;
  /** The tab's session, created when missing; undefined when the user has to act first. */
  ensureSession(tab: Tab): Effect.Effect<string | undefined, AgentStartError | AgentRequestError, Output | ExtensionCtx | Worktrees | ShadowGit>;
  cancelTab(tab: Tab): Effect.Effect<void, AgentRequestError | AuthRequiredError>;
  /** A turn ended that the user should hear about. */
  finished(tab: Tab): void;
  /** The tab's running turn is over: it is idle again. */
  turnEnded(tab: Tab): void;
}

/** The turns of chat tabs: sending messages, queueing them, taking them back. */
export class TabTurns {
  /** Ids of queued messages. */
  private nextQueued = 1;

  constructor(
    private readonly host: TurnsHost,
    /** Turn ids are unique across tabs and above the saved checkpoints' ones. */
    private turnId: number,
  ) {}

  /** A new turn id. */
  nextTurn(): number {
    return this.turnId++;
  }

  /** Answers the webview's messages about the tab's turns. */
  readonly onMessage = Effect.fn("TabTurns.onMessage")(function* (this: TabTurns, tab: Tab, msg: TurnMessage) {
    switch (msg.type) {
      case "send": {
        // The file open now, not when a queued message finally goes.
        const message: OutgoingMessage = { parts: msg.includeActiveFile ? withActiveFile(msg.parts) : msg.parts };
        if (msg.rewind !== undefined) {
          yield* this.resend(tab, msg.rewind, message, true);
        } else if (msg.now) {
          yield* this.sendNow(tab, message);
        } else {
          yield* this.send(tab, message);
        }
        break;
      }
      case "sendQueuedNow":
        yield* this.sendQueuedNow(tab, msg.id);
        break;
      case "unqueue":
        this.unqueue(tab, msg.id, msg.edit);
        break;
      case "editMessage":
        this.editMessage(tab, msg.turn);
        break;
      case "retry": {
        const sent = tab.sent.get(msg.turn);
        if (sent) {
          yield* this.resend(tab, msg.turn, sent, false);
        } else {
          this.host.postTab(tab, { type: "notice", key: "chat.cannotEdit" });
        }
        break;
      }
      default:
        msg satisfies never;
    }
  });

  /** Sends a message, or queues it while the tab is busy with a turn; queued ones follow when a turn ends. */
  readonly send = Effect.fn("TabTurns.send")(function* (this: TabTurns, tab: Tab, message: OutgoingMessage) {
    if (message.parts.every((part) => typeof part === "string" && !part.trim())) {
      return;
    }
    if (tab.busy || tab.sending) {
      tab.queue.push({ ...message, id: this.nextQueued++ });
      this.postQueue(tab);
      return;
    }
    tab.sending = true;
    yield* this.sendTurn(tab, message).pipe(
      Effect.ensuring(Effect.sync(() => (tab.sending = false))),
      Effect.onExit((exit) =>
        Effect.sync(() => {
          const stopReason = Exit.isSuccess(exit) ? exit.value : undefined;
          // A turn the user stopped needs no word; one the queue follows is not the end yet.
          if (stopReason && stopReason !== "cancelled" && !(stopReason === "end_turn" && tab.queue.length) && this.host.tabs.has(tab)) {
            this.host.finished(tab);
          }
          // The queue waits while the user looks at a turn they stopped, or that failed.
          if (tab.steer || stopReason === "end_turn") {
            this.sendQueued(tab);
          }
        }),
      ),
    );
  });

  /** Sends the first queued message, when the tab is idle. */
  sendQueued(tab: Tab): void {
    tab.steer = false;
    if (!this.host.tabs.has(tab) || tab.busy || tab.sending) {
      return;
    }
    const next = tab.queue.shift();
    if (next) {
      this.postQueue(tab);
      this.host.run(this.send(tab, next), tab);
    }
  }

  postQueue(tab: Tab): void {
    const items: QueuedInfo[] = tab.queue.map(({ id, parts }) => ({
      id,
      text: messageText(parts),
      attachments: parts.flatMap((part) => (typeof part !== "string" && !part.token ? [part.name] : [])),
    }));
    this.host.postTab(tab, { type: "queue", items });
  }

  /** Sends a message right away: a running turn is stopped, and the message goes first once it has. */
  private readonly sendNow = Effect.fn("TabTurns.sendNow")(function* (this: TabTurns, tab: Tab, message: OutgoingMessage) {
    if (!tab.busy && !tab.sending) {
      return yield* this.send(tab, message);
    }
    tab.queue.unshift({ ...message, id: this.nextQueued++ });
    this.postQueue(tab);
    yield* this.steer(tab);
  });

  /** Moves a queued message first and sends it, stopping the running turn. */
  private readonly sendQueuedNow = Effect.fn("TabTurns.sendQueuedNow")(function* (this: TabTurns, tab: Tab, id: number) {
    const index = tab.queue.findIndex((each) => each.id === id);
    if (index < 0) {
      return;
    }
    tab.queue.unshift(...tab.queue.splice(index, 1));
    this.postQueue(tab);
    if (tab.busy) {
      yield* this.steer(tab);
    } else {
      this.sendQueued(tab);
    }
  });

  /** Stops the running turn so the first queued message goes next. */
  private readonly steer = Effect.fn("TabTurns.steer")(function* (this: TabTurns, tab: Tab) {
    // Still preparing its prompt: the queue follows once that turn ends.
    if (tab.busy) {
      tab.steer = true;
      yield* this.host.cancelTab(tab);
    }
  });

  /** Takes a message out of the queue, back to the composer when it is to be edited. */
  private unqueue(tab: Tab, id: number, edit: boolean): void {
    const index = tab.queue.findIndex((each) => each.id === id);
    if (index < 0) {
      return;
    }
    const [message] = tab.queue.splice(index, 1);
    this.postQueue(tab);
    if (edit && message) {
      this.loadComposer(tab, { parts: [...message.parts] });
    }
  }

  loadComposer(tab: Tab, load: LoadComposer): void {
    this.host.postTab(tab, { type: "loadComposer", ...load });
  }

  /** Puts a sent message back in the composer, to change it and send it in place of the original. */
  private editMessage(tab: Tab, turn: number): void {
    const sent = tab.sent.get(turn);
    if (!sent) {
      this.host.postTab(tab, { type: "notice", key: "chat.cannotEdit" });
      return;
    }
    this.loadComposer(tab, { parts: [...sent.parts], rewind: turn });
  }

  /**
   * Takes back the user message of `turn` and the rest of the conversation, then sends `message` in its place.
   * The agent can't forget, so the prompt tells it what was taken back. An edit the user cancels goes back to
   * the composer.
   */
  private readonly resend = Effect.fn("TabTurns.resend")(function* (
    this: TabTurns,
    tab: Tab,
    turn: number,
    message: OutgoingMessage,
    edited: boolean,
  ) {
    const giveBack = () => {
      if (edited) {
        this.loadComposer(tab, { parts: [...message.parts], rewind: turn });
      }
    };
    if (!tab.sent.has(turn)) {
      this.host.postTab(tab, { type: "notice", key: "chat.cannotEdit" });
      return;
    }
    if (tab.busy || tab.sending) {
      void vscode.window.showInformationMessage(t("chat.rewindBusy"));
      return giveBack();
    }
    // The dialog leaves time to start another turn.
    if (!(yield* this.host.changes.rewind(tab, turn)) || tab.busy || tab.sending || !tab.sent.has(turn)) {
      return giveBack();
    }
    this.rewindTo(tab, turn);
    yield* this.send(tab, message);
  });

  /** Drops the user message of `turn` and what followed from the chat, and tells the agent with the next prompt. */
  rewindTo(tab: Tab, turn: number): void {
    const original = tab.sent.get(turn);
    const line = original ? messageText(original.parts).trim().split("\n")[0]! : "";
    const excerpt = line.length > MAX_EXCERPT_LENGTH ? `${line.slice(0, MAX_EXCERPT_LENGTH - 1)}…` : line;
    for (const each of [...tab.sent.keys()]) {
      if (each >= turn) {
        tab.sent.delete(each);
      }
    }
    this.host.changes.forgetFrom(tab, turn);
    tab.rewindNote = `[Note from the editor: the user went back in the conversation and took back their message "${excerpt}" and everything after it. Disregard that message, your replies to it and any later messages, as if they had never been sent, and continue from the message below.]`;
    this.host.postTab(tab, { type: "rewind", turn });
  }

  /** Runs a turn; its stop reason, or undefined when it could not start. */
  private readonly sendTurn = Effect.fn("TabTurns.sendTurn")(function* (
    this: TabTurns,
    tab: Tab,
    message: OutgoingMessage,
  ) {
    const { parts } = message;
    const text = messageText(parts);
    const sessionId = yield* this.host.ensureSession(tab);
    const agent = tab.running?.agent;
    if (!sessionId || !agent) {
      return;
    }
    const caps = agent.initializeResponse.agentCapabilities?.promptCapabilities ?? {};
    const prompt: Array<acp.ContentBlock> = [];
    const sent: Array<SentAttachment> = [];
    for (const attachment of parts) {
      if (typeof attachment === "string") {
        if (attachment.trim()) {
          prompt.push({ type: "text", text: attachment });
        }
        continue;
      }
      const block = yield* attachmentBlock(caps, yield* this.host.tabWorktrees.localize(tab, attachment)).pipe(
        Effect.catch((err) =>
          Effect.sync(() => {
            this.host.postTab(tab, { type: "error", text: t("chat.attachFailed", attachment.name, err.message) });
            return undefined;
          }),
        ),
      );
      sent.push({
        name: attachment.name,
        token: attachment.token,
        src: block?.type === "image" ? `data:${block.mimeType};base64,${block.data}` : undefined,
      });
      if (block) {
        prompt.push(block);
      }
    }
    if (prompt.length === 0) {
      return;
    }

    tab.used = true;
    tab.createdAt ??= Date.now();
    if (!tab.title) {
      const firstLine = text.trim().split("\n")[0] || sent[0]?.name || "";
      tab.title = firstLine.length > MAX_TITLE_LENGTH ? `${firstLine.slice(0, MAX_TITLE_LENGTH - 1)}…` : firstLine;
    }
    this.host.postTabs();
    const turn = this.nextTurn();
    tab.turn = turn;
    tab.sent.set(turn, message);
    yield* this.host.changes.beginTurn(tab, turn, text || sent[0]?.name || "");
    const notes = [tab.rewindNote, tab.changes.takeNote()].filter(Predicate.isString);
    tab.rewindNote = undefined;
    if (notes.length > 0) {
      prompt.unshift({ type: "text", text: notes.join("\n\n") });
    }
    this.host.postTab(tab, { type: "userMessage", text, attachments: sent, turn });
    tab.busy = true;
    this.host.status(tab, "chat.working");
    return yield* agent.prompt(sessionId, prompt).pipe(
      Effect.tap((res) => this.host.usage.recordTurn(tab, sessionId, res)),
      Effect.map((res) => {
        this.host.postTab(tab, { type: "turnEnd", stopReason: res.stopReason });
        return res.stopReason;
      }),
      Effect.catchTag("AuthRequiredError", () =>
        Effect.sync(() => {
          tab.sessionId = undefined;
          this.host.status(tab, "chat.needsLogin", { needsLogin: true });
          return undefined;
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          // A turn cancelled by a start over may end after the tab's next turn began.
          if (tab.turn !== turn) {
            return;
          }
          tab.busy = false;
          tab.turn = undefined;
          this.host.turnEnded(tab);
        }),
      ),
    );
  });
}
