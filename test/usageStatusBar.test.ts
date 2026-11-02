import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import * as NodePath from "@effect/platform-node-shared/NodePath";
import { afterEach, assert, beforeEach, describe, it, vi } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";
import { TestClock } from "effect/testing";
import * as vscode from "vscode";
import { ChatIndicators, type IndicatorsHost } from "../src/chat/indicators";
import type { Tab } from "../src/chat/tabs";
import { TabUsage } from "../src/chat/usage";
import { ExtensionCtx } from "../src/runtime";
import { NO_TOKENS, UsageLedger, type Totals } from "../src/usageLedger";
import { usageStatusView } from "../src/usageStatusBar";
import { __test } from "./stubs/vscode";

const totals = (total: number, turns = 1): Totals => ({ turns, tokens: { ...NO_TOKENS, total }, cost: {} });

beforeEach(() => __test.reset());
afterEach(() => vi.restoreAllMocks());

describe("usageStatusView", () => {
  it("shows the tab's tokens in short and its turns, the exact counts and today in the tooltip", () => {
    const view = usageStatusView(totals(1_234_567, 12), totals(2_000_000, 30));
    assert.strictEqual(view.text, "$(graph) 1.2M tokens · 12 turns");
    assert.include(view.tooltip, "This tab: 1,234,567 tokens · 12 turns");
    assert.include(view.tooltip, "Today: 2,000,000 tokens · 30 turns");
    assert.include(view.tooltip, "Click for the usage summary");
  });

  it("counts zero for a tab with no records", () => {
    assert.strictEqual(usageStatusView(undefined, totals(5)).text, "$(graph) 0 tokens · 0 turns");
  });

  it("follows the language setting", () => {
    __test.setSetting("codeAcp.language", "vi");
    const view = usageStatusView(totals(1500, 2), totals(1500, 2));
    assert.include(view.tooltip, "Tab này: 1.500 token · 2 lượt");
    assert.include(view.tooltip, "Hôm nay: 1.500 token · 2 lượt");
  });
});

describe("ChatIndicators usage", () => {
  it("follows the active tab and the ledger, and opens the usage page on click", async () => {
    const items = new Map<string, vscode.StatusBarItem>();
    vi.spyOn(vscode.window, "createStatusBarItem").mockImplementation(((id: string) => {
      const item = { show: vi.fn(), dispose: vi.fn() } as unknown as vscode.StatusBarItem;
      items.set(id, item);
      return item;
    }) as never);
    const changed = new vscode.EventEmitter<void>();
    const recorded = new Map([["claude a", totals(100, 1)], ["claude b", totals(2000, 3)]]);
    const ledger = {
      onDidChange: changed.event,
      session: (agentId: string, sessionId: string) => Effect.succeed(recorded.get(`${agentId} ${sessionId}`)),
      today: Effect.succeed(totals(9000, 9)),
    } as unknown as UsageLedger["Service"];
    const tabA = { sessionId: "a", agentId: "claude", cwd: "/a", configOptions: [] } as unknown as Tab;
    const tabB = { reopen: { sessionId: "b", agentId: "claude", cwd: "/b" }, cwd: "/b", configOptions: [] } as unknown as Tab;
    const unused = { sessionId: undefined, agentId: "claude", cwd: "/c", configOptions: [] } as unknown as Tab;
    const tabs = { active: tabA, all: [tabA, tabB, unused] };
    const usage = new TabUsage({ postTab: () => {}, saveTabs: () => {}, run: () => {} });
    const indicators = new ChatIndicators({
      manager: { agents: Effect.succeed([]) },
      tabs,
      permissions: { owners: [] },
      attention: { owners: () => [] },
      usage,
      showAttentionCommand: "show.attention",
      showUsageCommand: "codeAcp.showUsage",
      view: () => undefined,
      agentIdOf: () => Effect.succeed("claude"),
      reveal: () => {},
      run: (effect: Effect.Effect<void, never, UsageLedger>) => Effect.runSync(effect.pipe(Effect.provideService(UsageLedger, ledger))),
    } as unknown as IndicatorsHost);
    const item = items.get("codeAcp.usage")!;
    const flush = async () => {
      indicators.update();
      await Promise.resolve();
    };

    assert.strictEqual(item.command, "codeAcp.showUsage");
    await flush();
    assert.strictEqual(item.text, "$(graph) 100 tokens · 1 turns");

    tabs.active = tabB;
    await flush();
    assert.strictEqual(item.text, "$(graph) 2K tokens · 3 turns");

    tabs.active = unused;
    await flush();
    assert.strictEqual(item.text, "$(graph) 0 tokens · 0 turns");

    tabs.active = tabA;
    recorded.set("claude a", totals(250, 2));
    changed.fire();
    await Promise.resolve();
    assert.strictEqual(item.text, "$(graph) 250 tokens · 2 turns");

    indicators.dispose();
    recorded.set("claude a", totals(999, 9));
    changed.fire();
    await Promise.resolve();
    assert.strictEqual(item.text, "$(graph) 250 tokens · 2 turns");
    assert.strictEqual(vi.mocked(item.dispose).mock.calls.length, 1);
  });
});

describe("UsageLedger.today", () => {
  const ref = { agentId: "claude", sessionId: "s1", cwd: "/work" };
  const usage = { totalTokens: 150, inputTokens: 100, outputTokens: 50 };

  it.effect("sums the current day's records, and starts over the next day", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const storage = yield* fs.makeTempDirectoryScoped();
      const context = { globalStorageUri: { fsPath: storage }, globalState: { get: () => undefined } } as unknown as vscode.ExtensionContext;
      const layer = UsageLedger.layer.pipe(Layer.provide(Layer.succeed(ExtensionCtx, context)));
      yield* Effect.gen(function* () {
        const ledger = yield* UsageLedger;
        assert.strictEqual((yield* ledger.today).tokens.total, 0);
        yield* ledger.recordTurn(ref, usage);
        yield* ledger.recordTurn(ref, usage);
        const today = yield* ledger.today;
        assert.strictEqual(today.tokens.total, 300);
        assert.strictEqual(today.turns, 2);
        yield* TestClock.adjust("24 hours");
        assert.strictEqual((yield* ledger.today).turns, 0);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))),
  );
});
