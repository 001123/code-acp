import type * as acp from "@agentclientprotocol/sdk";
import { Deferred, Effect } from "effect";

export const CANCELLED: acp.RequestPermissionResponse = { outcome: { outcome: "cancelled" } };

interface Pending<T> {
  readonly owner: T;
  readonly answer: Deferred.Deferred<acp.RequestPermissionResponse>;
}

/** Permission requests waiting for the user, each owned by the tab it shows in. */
export class Permissions<T> {
  private nextId = 1;
  private readonly pending = new Map<number, Pending<T>>();

  constructor(
    private readonly events: {
      /** Shows request `id` in its tab. */
      readonly shown: (owner: T, id: number, request: acp.RequestPermissionRequest) => void;
      /** Request `id` was answered, by the user or by a cancel. */
      readonly done: (owner: T, id: number) => void;
    },
  ) {}

  /** Shows the request and waits for its answer; the agent aborting it answers "cancelled". */
  readonly request = Effect.fn("Permissions.request")(function* (
    this: Permissions<T>,
    owner: T,
    request: acp.RequestPermissionRequest,
    signal: AbortSignal,
  ) {
    const id = this.nextId++;
    const answer = yield* Deferred.make<acp.RequestPermissionResponse>();
    this.pending.set(id, { owner, answer });
    this.events.shown(owner, id, request);
    const onAbort = () => this.resolve(id, CANCELLED);
    signal.addEventListener("abort", onAbort, { once: true });
    return yield* Deferred.await(answer).pipe(
      Effect.ensuring(Effect.sync(() => signal.removeEventListener("abort", onAbort))),
    );
  });

  /** The user's pick for request `id`; null dismisses it. */
  answer(id: number, optionId: string | null): void {
    this.resolve(id, optionId ? { outcome: { outcome: "selected", optionId } } : CANCELLED);
  }

  /** Answers "cancelled" to the pending requests of `owner`, or to all of them. */
  cancel(owner?: T): void {
    for (const [id, pending] of [...this.pending]) {
      if (owner === undefined || pending.owner === owner) {
        this.resolve(id, CANCELLED);
      }
    }
  }

  private resolve(id: number, response: acp.RequestPermissionResponse): void {
    const pending = this.pending.get(id);
    if (pending) {
      this.pending.delete(id);
      Deferred.doneUnsafe(pending.answer, Effect.succeed(response));
      this.events.done(pending.owner, id);
    }
  }
}
