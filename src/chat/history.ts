import type * as acp from "@agentclientprotocol/sdk";
import { Effect, Result } from "effect";
import type { AcpAgent } from "../acpClient";

/** Pages of `session/list` fetched per folder for the history list. */
const MAX_HISTORY_PAGES = 5;

export type HistoryListing =
  | { readonly unsupported: true }
  | { readonly unsupported: false; readonly sessions: ReadonlyArray<acp.SessionInfo>; readonly canOpen: boolean };

/** Whether the agent can show a past session again: replayed (session/load) or continued (session/resume). */
export function canReopen(agent: AcpAgent): boolean {
  const caps = agent.initializeResponse.agentCapabilities;
  return !!caps?.loadSession || !!caps?.sessionCapabilities?.resume;
}

/**
 * The agent's past sessions in `folders` (every root of a multi-root workspace), each listed once. A folder the
 * agent can't list is skipped, unless none can be.
 */
export const listHistory = Effect.fn("listHistory")(function* (agent: AcpAgent, folders: ReadonlyArray<string>) {
  if (!agent.initializeResponse.agentCapabilities?.sessionCapabilities?.list) {
    return { unsupported: true } as HistoryListing;
  }
  const byId = new Map<string, acp.SessionInfo>();
  const listFolder = Effect.fnUntraced(function* (cwd: string) {
    let cursor: string | undefined;
    for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
      const res = yield* agent.listSessions(cwd, cursor);
      for (const session of res.sessions) {
        byId.set(session.sessionId, session);
      }
      cursor = res.nextCursor ?? undefined;
      if (!cursor) {
        break;
      }
    }
  });
  const results = yield* Effect.forEach(folders, (cwd) => Effect.result(listFolder(cwd)));
  const failure = results.find(Result.isFailure);
  if (failure && results.every(Result.isFailure)) {
    return yield* failure.failure;
  }
  // Without load or resume the list can only be looked at.
  return { unsupported: false, sessions: [...byId.values()], canOpen: canReopen(agent) } as HistoryListing;
});

/** Numbers history requests, so a slower, older listing does not replace a newer one. */
export class HistoryRequests {
  private latest = 0;

  /** Starts a request; the returned function tells whether it is still the latest. */
  next(): () => boolean {
    const id = ++this.latest;
    return () => id === this.latest;
  }
}
