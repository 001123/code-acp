import type * as acp from "@agentclientprotocol/sdk";
import { Option, Predicate } from "effect";
import { choicesOf, modelOption, thoughtOption } from "../sessionOptions";
import { parentToolUseId, startsSubagent } from "../ui/chat/toolMeta";
import { decodeTurnUsage } from "../usageLedger";
import type { TurnChanges, TurnTrace } from "./protocol";
import { usageOf, type Tab } from "./tabs";

type Select = ReturnType<typeof modelOption>;

const chosenName = (option: Select) => option && choicesOf(option).find((c) => c.value === option.currentValue)?.name;

/** What the turn cost: ACP reports the session's total, which starts over when the agent restarts. */
function turnCost(cost: acp.Cost, before: acp.Cost | null | undefined): number {
  return before && before.currency === cost.currency && cost.amount >= before.amount ? cost.amount - before.amount : cost.amount;
}

/** Tool calls that don't say what kind they are, as in ACP. */
const DEFAULT_TOOL_KIND = "other";

/** What the client sees of a running turn. */
export class TurnStats {
  private firstResponseAt: number | undefined;
  private readonly tools = new Map<string, { kind: string; failed: boolean }>();
  private readonly subagents = new Set<string>();
  private asks = 0;
  private openAsks = 0;
  private waitingSince = 0;
  private waited = 0;

  constructor(private readonly startedAt = Date.now()) {}

  onUpdate(update: acp.SessionUpdate, now = Date.now()): void {
    const { sessionUpdate } = update;
    if (sessionUpdate === "agent_message_chunk" || sessionUpdate === "agent_thought_chunk" || sessionUpdate === "tool_call") {
      this.firstResponseAt ??= now;
    }
    if (sessionUpdate !== "tool_call" && sessionUpdate !== "tool_call_update") {
      return;
    }
    const known = this.tools.get(update.toolCallId);
    this.tools.set(update.toolCallId, {
      kind: update.kind ?? known?.kind ?? DEFAULT_TOOL_KIND,
      // An update without a status leaves it as it was.
      failed: update.status ? update.status === "failed" : (known?.failed ?? false),
    });
    if (startsSubagent(update)) {
      this.subagents.add(update.toolCallId);
    }
    const parent = parentToolUseId(update);
    if (parent !== undefined) {
      this.subagents.add(parent);
    }
  }

  /** The agent asked the user something. Questions asked at the same time are one wait. */
  askShown(now = Date.now()): void {
    this.asks++;
    if (this.openAsks++ === 0) {
      this.waitingSince = now;
    }
  }

  askDone(now = Date.now()): void {
    if (this.openAsks > 0 && --this.openAsks === 0) {
      this.waited += now - this.waitingSince;
    }
  }

  summary(now = Date.now()): TurnSummary {
    const kinds: Record<string, number> = {};
    let failed = 0;
    for (const tool of this.tools.values()) {
      kinds[tool.kind] = (kinds[tool.kind] ?? 0) + 1;
      failed += tool.failed ? 1 : 0;
    }
    return {
      durationMs: now - this.startedAt,
      ...(this.firstResponseAt === undefined ? {} : { firstResponseMs: this.firstResponseAt - this.startedAt }),
      waiting: { asks: this.asks, ms: this.waited + (this.openAsks > 0 ? now - this.waitingSince : 0) },
      tools: { total: this.tools.size, failed, kinds },
      subagents: this.subagents.size,
    };
  }
}

export type TurnSummary = Pick<TurnTrace, "durationMs" | "firstResponseMs" | "waiting" | "tools" | "subagents">;

/** The numbers of a turn that just ended; `costBefore` is the session's cost when it started. */
export function turnTrace(
  tab: Tab,
  sessionId: string,
  response: acp.PromptResponse,
  measured: {
    readonly stats: TurnSummary;
    readonly costBefore: acp.Cost | null | undefined;
    readonly changes?: TurnChanges | undefined;
    readonly number?: number | undefined;
  },
): TurnTrace {
  const { stats, costBefore, changes, number } = measured;
  const info = tab.running?.agent.initializeResponse.agentInfo;
  const agent = info && [info.title ?? info.name, info.version].filter(Boolean).join(" ");
  const model = chosenName(modelOption(tab.configOptions));
  const effort = chosenName(thoughtOption(tab.configOptions));
  // `usage` is unstable in ACP, so the stable PromptResponse leaves it out.
  const usage = Predicate.hasProperty(response, "usage") ? Option.getOrUndefined(decodeTurnUsage(response.usage)) : undefined;
  const reported = usageOf(tab, sessionId);
  return {
    stopReason: response.stopReason,
    ...stats,
    sessionId,
    ...(changes ? { changes } : {}),
    // The ledger counts a turn before it is shown, so 0 means it has none of the session's turns.
    ...(number ? { number } : {}),
    ...(agent ? { agent } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(usage
      ? {
          tokens: {
            total: usage.totalTokens,
            input: usage.inputTokens,
            output: usage.outputTokens,
            cachedRead: usage.cachedReadTokens ?? undefined,
            cachedWrite: usage.cachedWriteTokens ?? undefined,
            thought: usage.thoughtTokens ?? undefined,
          },
        }
      : {}),
    ...(reported ? { context: { used: reported.used, size: reported.size } } : {}),
    ...(reported?.cost
      ? { cost: { turn: turnCost(reported.cost, costBefore), session: reported.cost.amount, currency: reported.cost.currency } }
      : {}),
  };
}
