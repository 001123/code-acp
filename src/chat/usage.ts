import type * as acp from "@agentclientprotocol/sdk";
import { Effect, Option, Predicate } from "effect";
import { ClaudeSettings } from "../claudeSettings";
import { UsageLedger, type SessionRef } from "../usageLedger";
import type { ChatUi } from "./host";
import { usageOf, type Tab } from "./tabs";

/** `_meta` key on Claude agents' `usage_update` naming the model the usage belongs to. */
const CLAUDE_MODEL_META = "_claude/model";

/** The context usage and the spending of chat tabs' sessions. */
export class TabUsage {
  constructor(private readonly host: Pick<ChatUi, "postTab" | "saveTabs" | "run">) {}

  /** Shows the saved usage of the tab's session (or the one it will reopen) until the agent reports again. */
  postSaved(tab: Tab): void {
    const sessionId = tab.sessionId ?? tab.reopen?.sessionId;
    const usage = sessionId === undefined ? undefined : usageOf(tab, sessionId);
    if (!usage) {
      return;
    }
    const { compactAt, ...reported } = usage;
    this.host.postTab(tab, { type: "update", update: { sessionUpdate: "usage_update", ...reported } });
    this.host.postTab(tab, { type: "compactWindow", size: compactAt ?? null });
    this.host.run(this.postTotals(tab), tab);
  }

  /** The ledger entry of a tab's session; undefined until it has one and knows its agent. */
  private sessionRef(tab: Tab, sessionId: string | undefined = tab.sessionId): SessionRef | undefined {
    const agentId = tab.running?.agentId ?? tab.reopen?.agentId ?? tab.agentId;
    // A worktree's usage counts for the folder it came from.
    return agentId && sessionId ? { agentId, sessionId, cwd: tab.worktree?.base ?? tab.cwd, title: tab.name ?? tab.title } : undefined;
  }

  /** The tokens, turns and cost recorded for the tab's session (or the one it will reopen). */
  readonly totals = Effect.fn("TabUsage.totals")(function* (this: TabUsage, tab: Tab) {
    const ref = this.sessionRef(tab, tab.sessionId ?? tab.reopen?.sessionId);
    return ref ? yield* (yield* UsageLedger).session(ref.agentId, ref.sessionId) : undefined;
  });

  /** Shows the session's totals with its context usage. */
  private readonly postTotals = Effect.fn("TabUsage.postTotals")(function* (this: TabUsage, tab: Tab) {
    const totals = yield* this.totals(tab);
    this.host.postTab(tab, { type: "sessionTotals", totals: totals ?? null });
  });

  /** Records a finished turn's tokens and shows the session's new totals. */
  recordTurn(tab: Tab, sessionId: string, response: acp.PromptResponse) {
    const ref = this.sessionRef(tab, sessionId);
    // `usage` is unstable in ACP, so the stable PromptResponse leaves it out.
    const usage = Predicate.hasProperty(response, "usage") ? response.usage : undefined;
    return ref ? UsageLedger.use((ledger) => ledger.recordTurn(ref, usage)).pipe(Effect.andThen(this.postTotals(tab))) : Effect.void;
  }

  /** Keeps what the agent reports about the session's usage; its spending goes to the ledger. */
  onUpdate(tab: Tab, sessionId: string, update: acp.UsageUpdate): void {
    const { used, size, cost } = update;
    const ref = this.sessionRef(tab, sessionId);
    if (cost && ref) {
      // Read before it is replaced: a reopened session's last cost is not new spending.
      const previous = usageOf(tab, sessionId)?.cost ?? undefined;
      this.host.run(
        UsageLedger.use((ledger) => ledger.recordCost(ref, cost, previous)).pipe(Effect.andThen(this.postTotals(tab))),
        tab,
      );
    }
    const compactAt = tab.usageSessionId === sessionId ? tab.usage?.compactAt : undefined;
    tab.usage = { used, size, cost, compactAt };
    tab.usageSessionId = sessionId;
    this.host.saveTabs();
    this.postCompactWindow(tab, update);
  }

  /**
   * Claude agents name the model in `_meta`, but report its full window as `size`; Claude Code
   * compacts earlier when `autoCompactWindow` is set, so the meter also shows that limit.
   */
  private postCompactWindow(tab: Tab, update: acp.UsageUpdate): void {
    const model = update._meta?.[CLAUDE_MODEL_META];
    if (!Predicate.isString(model)) {
      return;
    }
    this.host.run(
      Effect.gen({ self: this }, function* () {
        const window = yield* (yield* ClaudeSettings).autoCompactWindow(model, tab.cwd);
        if (tab.usage) {
          tab.usage = { ...tab.usage, compactAt: Option.getOrUndefined(window) };
          this.host.saveTabs();
        }
        this.host.postTab(tab, { type: "compactWindow", size: Option.getOrNull(window) });
      }),
      tab,
    );
  }
}
