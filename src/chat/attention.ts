/** Why a tab wants the user: a permission request, or a turn that ended. */
export type AttentionReason = "permission" | "finished";

/**
 * Tabs that want the user while they look elsewhere: another tab, another view or another window. Their count is the
 * chat view's badge; each one is announced once per reason.
 */
export class Attention<T> {
  private readonly marked = new Map<T, AttentionReason>();

  constructor(
    private readonly events: {
      /** Whether the user sees `owner` now: the window has focus, the view shows and `owner` is its active tab. */
      readonly sees: (owner: T) => boolean;
      readonly badge: (count: number) => void;
      readonly notify: (owner: T, reason: AttentionReason) => void;
    },
  ) {}

  get count(): number {
    return this.marked.size;
  }

  /** `owner` wants the user; marked and announced unless they see it already. */
  raise(owner: T, reason: AttentionReason): void {
    if (this.events.sees(owner) || this.marked.get(owner) === reason) {
      return;
    }
    this.marked.set(owner, reason);
    this.events.badge(this.marked.size);
    this.events.notify(owner, reason);
  }

  /** What `owner` wanted for `reason` is over, e.g. its permission request was answered. */
  settle(owner: T, reason: AttentionReason): void {
    if (this.marked.get(owner) === reason) {
      this.clear(owner);
    }
  }

  clear(owner: T): void {
    if (this.marked.delete(owner)) {
      this.events.badge(this.marked.size);
    }
  }

  /** Clears the tabs the user sees now, after the window, view or active tab changed. */
  refresh(): void {
    for (const owner of [...this.marked.keys()]) {
      if (this.events.sees(owner)) {
        this.clear(owner);
      }
    }
  }
}
