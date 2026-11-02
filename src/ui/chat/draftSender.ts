import type { Draft } from "../../chat/protocol";

/** Short: the window can reload at any moment, and the webview gets no chance to send what is still waiting here. */
const DRAFT_DELAY_MS = 100;

export type DraftMessage = { type: "draft"; tab: number; draft: Draft } | { type: "draftText"; tab: number; text: string };

/** Sends drafts to the extension, which keeps them across reloads: the latest per pause in typing, one tab at a time. */
export class DraftSender {
  private pending?: { tab: number; draft: Draft; timer: ReturnType<typeof setTimeout> };
  /** Per tab, the tokens and attachments last sent with a draft; while they stay the same, only the text goes out. */
  private readonly sent = new Map<number, unknown[]>();

  constructor(
    private readonly send: (message: DraftMessage) => void,
    private readonly delayMs = DRAFT_DELAY_MS,
  ) {}

  save(tab: number, draft: Draft): void {
    if (this.pending?.tab !== tab) this.flush();
    else clearTimeout(this.pending.timer);
    this.pending = { tab, draft, timer: setTimeout(() => this.flush(), this.delayMs) };
  }

  flush(): void {
    const pending = this.pending;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending = undefined;
    const { tab, draft } = pending;
    // Attachments can be megabytes of base64; resending them on every keystroke pause is wasted work.
    const refs = [...draft.inline.flatMap((x) => [x.token, x.attachment]), ...draft.attachments];
    const last = this.sent.get(tab);
    if (last && last.length === refs.length && last.every((x, i) => x === refs[i])) {
      this.send({ type: "draftText", tab, text: draft.text });
      return;
    }
    this.sent.set(tab, refs);
    this.send({ type: "draft", tab, draft });
  }

  /** Forgets the tabs `open` says are gone. */
  prune(open: (tab: number) => boolean): void {
    for (const tab of this.sent.keys()) if (!open(tab)) this.sent.delete(tab);
  }
}
