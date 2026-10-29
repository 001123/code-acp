import { Effect, Exit, Scope, Semaphore } from "effect";
import type { RunningAgent } from "./tabs";

/** The agent processes of the chat, one per agent id, shared by the tabs on that agent. */
export class AgentPool {
  private readonly running = new Map<string, RunningAgent>();
  /** Per agent id: makes concurrent callers share one start, without one slow agent holding up the others. */
  private readonly startLocks = new Map<string, Semaphore.Semaphore>();

  /** The process of `agentId`, started with `start` when there is none. */
  get<E, R>(agentId: string, start: Effect.Effect<RunningAgent, E, R>): Effect.Effect<RunningAgent, E, R> {
    let lock = this.startLocks.get(agentId);
    if (!lock) {
      this.startLocks.set(agentId, (lock = Semaphore.makeUnsafe(1)));
    }
    return Semaphore.withPermits(lock, 1)(
      Effect.suspend(() => {
        const running = this.running.get(agentId);
        return running ? Effect.succeed(running) : Effect.tap(start, (started) => Effect.sync(() => this.running.set(agentId, started)));
      }),
    );
  }

  /** Whether `running` is still the process of its agent (not stopped or replaced). */
  isCurrent(running: RunningAgent): boolean {
    return this.running.get(running.agentId) === running;
  }

  ids(): string[] {
    return [...this.running.keys()];
  }

  /** Forgets the processes of `agentId`, or all; returns them so the caller can stop them after updating its tabs. */
  take(agentId?: string): RunningAgent[] {
    const taken = [...this.running.values()].filter((running) => agentId === undefined || running.agentId === agentId);
    for (const running of taken) {
      this.running.delete(running.agentId);
    }
    return taken;
  }

  /** Forgets a process that exited on its own. */
  forget(running: RunningAgent): void {
    if (this.isCurrent(running)) {
      this.running.delete(running.agentId);
    }
  }

  /** Stops the processes `inUse` says no tab needs. */
  readonly stopIdle = Effect.fn("AgentPool.stopIdle")(function* (this: AgentPool, inUse: (running: RunningAgent) => boolean) {
    for (const running of [...this.running.values()]) {
      if (!inUse(running)) {
        this.running.delete(running.agentId);
        yield* Scope.close(running.scope, Exit.void);
      }
    }
  });
}

/** Kills the processes; scope finalizers are synchronous, so they are gone when the effect completes. */
export const stopAll = (stopped: ReadonlyArray<RunningAgent>): Effect.Effect<void> =>
  Effect.forEach(stopped, (running) => Scope.close(running.scope, Exit.void), { discard: true });
