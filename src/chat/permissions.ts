import type * as acp from "@agentclientprotocol/sdk";
import { Deferred, Effect } from "effect";
import type { FormElicitation } from "../acpClient";

export const CANCELLED: acp.RequestPermissionResponse = { outcome: { outcome: "cancelled" } };

export const ELICITATION_CANCELLED: acp.CreateElicitationResponse = { action: "cancel" };

/** What the agent asks the user: to allow a tool call, or to fill in a form (an elicitation). */
export type Ask =
  | { readonly kind: "permission"; readonly request: acp.RequestPermissionRequest }
  | { readonly kind: "elicitation"; readonly request: FormElicitation };

export type Answer =
  | { readonly kind: "permission"; readonly response: acp.RequestPermissionResponse }
  | { readonly kind: "elicitation"; readonly response: acp.CreateElicitationResponse };

const cancelled = (kind: Ask["kind"]): Answer =>
  kind === "permission" ? { kind, response: CANCELLED } : { kind, response: ELICITATION_CANCELLED };

interface Pending<T> {
  readonly owner: T;
  readonly kind: Ask["kind"];
  readonly answer: Deferred.Deferred<Answer>;
}

/** Permission requests and questions waiting for the user, each owned by the tab it shows in. */
export class Permissions<T> {
  private nextId = 1;
  private readonly pending = new Map<number, Pending<T>>();

  constructor(
    private readonly events: {
      /** Shows request `id` in its tab. */
      readonly shown: (owner: T, id: number, ask: Ask) => void;
      /** Request `id` was answered, by the user or by a cancel. */
      readonly done: (owner: T, id: number, answer: Answer) => void;
    },
  ) {}

  /** Shows the request and waits for its answer; the agent aborting it answers "cancelled". */
  readonly request = Effect.fn("Permissions.request")(function* (
    this: Permissions<T>,
    owner: T,
    request: acp.RequestPermissionRequest,
    signal: AbortSignal,
  ) {
    const answer = yield* this.wait(owner, { kind: "permission", request }, signal);
    return answer.kind === "permission" ? answer.response : CANCELLED;
  });

  /** Shows the form and waits for what the user filled in; the agent aborting it answers "cancel". */
  readonly elicit = Effect.fn("Permissions.elicit")(function* (
    this: Permissions<T>,
    owner: T,
    request: FormElicitation,
    signal: AbortSignal,
  ) {
    const answer = yield* this.wait(owner, { kind: "elicitation", request }, signal);
    return answer.kind === "elicitation" ? answer.response : ELICITATION_CANCELLED;
  });

  private readonly wait = Effect.fnUntraced(function* (this: Permissions<T>, owner: T, ask: Ask, signal: AbortSignal) {
    const id = this.nextId++;
    const answer = yield* Deferred.make<Answer>();
    this.pending.set(id, { owner, kind: ask.kind, answer });
    this.events.shown(owner, id, ask);
    const onAbort = () => this.resolve(id, cancelled(ask.kind));
    signal.addEventListener("abort", onAbort, { once: true });
    return yield* Deferred.await(answer).pipe(
      Effect.ensuring(Effect.sync(() => signal.removeEventListener("abort", onAbort))),
    );
  });

  /** The owners of the pending requests, the earliest request first, each once. */
  get owners(): T[] {
    return [...new Set([...this.pending.values()].map((p) => p.owner))];
  }

  /** The user's pick for permission request `id`; null dismisses it. */
  answer(id: number, optionId: string | null): void {
    if (this.pending.get(id)?.kind === "permission") {
      this.resolve(id, {
        kind: "permission",
        response: optionId ? { outcome: { outcome: "selected", optionId } } : CANCELLED,
      });
    }
  }

  /** The user's answer to question `id`. */
  answerElicitation(id: number, response: acp.CreateElicitationResponse): void {
    if (this.pending.get(id)?.kind === "elicitation") {
      this.resolve(id, { kind: "elicitation", response });
    }
  }

  /** Answers "cancelled" to the pending requests of `owner`, or to all of them. */
  cancel(owner?: T): void {
    for (const [id, pending] of [...this.pending]) {
      if (owner === undefined || pending.owner === owner) {
        this.resolve(id, cancelled(pending.kind));
      }
    }
  }

  private resolve(id: number, answer: Answer): void {
    const pending = this.pending.get(id);
    if (pending) {
      this.pending.delete(id);
      Deferred.doneUnsafe(pending.answer, Effect.succeed(answer));
      this.events.done(pending.owner, id, answer);
    }
  }
}
