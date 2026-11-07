/** When the user last sent a message, so only that message animates in, not ones replayed from history. */
let sentAt = -Infinity;

/** Marks a message as just sent and replays the send button's launch animation. */
export function markSent(button: HTMLElement | null): void {
  sentAt = performance.now();
  if (!button) return;
  button.removeAttribute("data-launch");
  void button.offsetWidth;
  button.setAttribute("data-launch", "");
}

/** Whether a user message mounting now is the one just sent. */
export function justSent(): boolean {
  return performance.now() - sentAt < 2000;
}
