// @vitest-environment happy-dom
import type * as acp from "@agentclientprotocol/sdk";
import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest";
import { act, createElement } from "react";
import { vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { makeTraceLog, sanitize, tapStream } from "../src/acpTrace";
import type { TurnTrace } from "../src/chat/protocol";
import { TurnStats, turnTrace } from "../src/chat/trace";
import type { Tab } from "../src/chat/tabs";
import { TurnTraceView } from "../src/ui/chat/turnTrace";
import en from "../src/l10n/en";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const posted = vi.hoisted(() => {
  const posted: unknown[] = [];
  (globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi = () => ({ postMessage: (message: unknown) => void posted.push(message), getState: () => undefined, setState: () => {} });
  return posted;
});

const chunk = (text: string, sessionUpdate = "agent_message_chunk") => ({
  jsonrpc: "2.0",
  method: "session/update",
  params: { sessionId: "s", update: { sessionUpdate, content: { type: "text", text } } },
});

const logOf = (on: () => boolean = () => true) => {
  const lines: string[] = [];
  return { lines, log: makeTraceLog((line) => void lines.push(line), on, "agent#1") };
};

const bodyOf = (line: string) => JSON.parse(line.slice(line.indexOf("{")));

describe("sanitize", () => {
  it("masks env and header values, in pairs and in records", () => {
    assert.deepStrictEqual(
      sanitize({
        mcpServers: [
          { name: "a", command: "x", env: [{ name: "KEY", value: "s3cret" }] },
          { name: "b", url: "u", headers: [{ name: "Authorization", value: "Bearer s3cret" }] },
        ],
        env: { KEY: "s3cret" },
      }),
      {
        mcpServers: [
          { name: "a", command: "x", env: [{ name: "KEY", value: "***" }] },
          { name: "b", url: "u", headers: [{ name: "Authorization", value: "***" }] },
        ],
        env: { KEY: "***" },
      },
    );
  });

  it("masks strings named like secrets, and keeps token counts", () => {
    assert.deepStrictEqual(sanitize({ apiKey: "s3cret", access_token: "s3cret", totalTokens: 12, title: "hi", none: null }), {
      apiKey: "***",
      access_token: "***",
      totalTokens: 12,
      title: "hi",
      none: null,
    });
  });

  it("cuts long strings and says how much is left out", () => {
    const cut = sanitize({ data: "x".repeat(20_005) }) as { data: string };
    assert.isTrue(cut.data.endsWith("…[+5]"));
    assert.strictEqual(cut.data.length, 20_000 + "…[+5]".length);
  });
});

describe("makeTraceLog", () => {
  it("logs nothing while off, and picks up when turned on", () => {
    let on = false;
    const { lines, log } = logOf(() => on);
    log.record("→", { jsonrpc: "2.0", id: 1, method: "initialize" });
    assert.deepStrictEqual(lines, []);
    on = true;
    log.record("→", { jsonrpc: "2.0", id: 2, method: "session/new" });
    assert.strictEqual(lines.length, 1);
    assert.match(lines[0]!, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[agent#1\] → \{/);
    assert.strictEqual(bodyOf(lines[0]!).method, "session/new");
  });

  it("joins streamed text into one line, before the message that follows it", () => {
    const { lines, log } = logOf();
    log.record("←", chunk("hello "));
    log.record("←", chunk("world"));
    assert.deepStrictEqual(lines, []);
    log.record("←", { jsonrpc: "2.0", id: 1, result: { stopReason: "end_turn" } });
    assert.strictEqual(lines.length, 2);
    assert.include(lines[0]!, "← ×2 ");
    assert.strictEqual(bodyOf(lines[0]!).params.update.content.text, "hello world");
    assert.strictEqual(bodyOf(lines[1]!).result.stopReason, "end_turn");
  });

  it("keeps thoughts apart from the reply", () => {
    const { lines, log } = logOf();
    log.record("←", chunk("hmm", "agent_thought_chunk"));
    log.record("←", chunk("hello"));
    log.flush();
    assert.deepStrictEqual(lines.map((line) => bodyOf(line).params.update.sessionUpdate), ["agent_thought_chunk", "agent_message_chunk"]);
  });

  it("does not join a chunk carrying anything else, which would lose it", () => {
    const { lines, log } = logOf();
    log.record("←", chunk("a"));
    const withMeta = chunk("b");
    log.record("←", { ...withMeta, params: { ...withMeta.params, update: { ...withMeta.params.update, _meta: { x: 1 } } } });
    assert.strictEqual(lines.length, 2);
    assert.deepStrictEqual(bodyOf(lines[1]!).params.update._meta, { x: 1 });
  });

  it("survives a write that fails", () => {
    const log = makeTraceLog(() => {
      throw new Error("channel closed");
    }, () => true, "agent");
    log.record("→", { id: 1 });
    log.record("←", chunk("a"));
    log.flush();
  });
});

describe("tapStream", () => {
  it("passes messages through both ways and records them", async () => {
    const lines: string[] = [];
    const log = makeTraceLog((line) => void lines.push(line), () => true, "a");
    const sent: unknown[] = [];
    let closed = false;
    const tapped = tapStream(
      {
        readable: new ReadableStream<unknown>({
          start(controller) {
            controller.enqueue({ id: 1, result: {} });
            controller.close();
          },
        }),
        writable: new WritableStream<unknown>({
          write: (message) => void sent.push(message),
          close: () => void (closed = true),
        }),
      },
      log,
    );
    const writer = tapped.writable.getWriter();
    await writer.write({ id: 1, method: "initialize" });
    await writer.close();
    const reader = tapped.readable.getReader();
    assert.deepStrictEqual((await reader.read()).value, { id: 1, result: {} });
    assert.isTrue((await reader.read()).done);
    assert.deepStrictEqual(sent, [{ id: 1, method: "initialize" }]);
    assert.isTrue(closed);
    assert.deepStrictEqual(lines.map((line) => line.split(" ")[2]), ["→", "←"]);
  });
});

describe("TurnStats", () => {
  const tool = (toolCallId: string, more: Record<string, unknown> = {}) => ({ sessionUpdate: "tool_call", toolCallId, title: "t", ...more }) as acp.SessionUpdate;
  const update = (toolCallId: string, more: Record<string, unknown> = {}) =>
    ({ sessionUpdate: "tool_call_update", toolCallId, ...more }) as acp.SessionUpdate;
  const text = { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } } as acp.SessionUpdate;

  it("measures the first response from what the agent says or does", () => {
    const stats = new TurnStats(100);
    assert.isUndefined(stats.summary(150).firstResponseMs);
    stats.onUpdate({ sessionUpdate: "usage_update", used: 1, size: 2 }, 120);
    assert.isUndefined(stats.summary(150).firstResponseMs);
    stats.onUpdate(text, 130);
    stats.onUpdate(text, 140);
    const { firstResponseMs, durationMs } = stats.summary(200);
    assert.strictEqual(firstResponseMs, 30);
    assert.strictEqual(durationMs, 100);
  });

  it("counts each tool call once, by kind, with those that ended failed", () => {
    const stats = new TurnStats(0);
    stats.onUpdate(tool("a", { kind: "read", status: "pending" }));
    stats.onUpdate(update("a", { status: "completed" }));
    stats.onUpdate(tool("b", { kind: "edit" }));
    stats.onUpdate(update("b", { status: "failed" }));
    stats.onUpdate(update("b", { title: "still failed" }));
    stats.onUpdate(tool("c", { kind: "edit", status: "failed" }));
    stats.onUpdate(update("c", { status: "completed" }));
    stats.onUpdate(tool("d"));
    assert.deepStrictEqual(stats.summary().tools, { total: 4, failed: 1, kinds: { read: 1, edit: 2, other: 1 } });
  });

  it("counts subagents, whether their start or only their calls are seen", () => {
    const stats = new TurnStats(0);
    stats.onUpdate(tool("a", { _meta: { claudeCode: { toolName: "Agent" } } }));
    stats.onUpdate(tool("a1", { _meta: { claudeCode: { parentToolUseId: "a" } } }));
    stats.onUpdate(tool("b1", { _meta: { claudeCode: { parentToolUseId: "b" } } }));
    stats.onUpdate(tool("c", { _meta: { claudeCode: { toolName: "Read" } } }));
    assert.strictEqual(stats.summary().subagents, 2);
  });

  it("counts time waiting for the user once while questions overlap, and a wait still open", () => {
    const stats = new TurnStats(0);
    stats.askShown(10);
    stats.askShown(20);
    stats.askDone(30);
    stats.askDone(40);
    stats.askDone(45);
    assert.deepStrictEqual(stats.summary(50).waiting, { asks: 2, ms: 30 });
    stats.askShown(60);
    assert.deepStrictEqual(stats.summary(70).waiting, { asks: 3, ms: 40 });
  });
});

describe("turnTrace", () => {
  const tabWith = (usage?: Tab["usage"]) =>
    ({
      usage,
      usageSessionId: "s",
      configOptions: [],
      running: { agent: { initializeResponse: { agentInfo: { name: "mock", version: "1.0" } } } },
    }) as unknown as Tab;
  const stats = { durationMs: 5, waiting: { asks: 0, ms: 0 }, tools: { total: 0, failed: 0, kinds: {} }, subagents: 0 };
  const measured = (costBefore?: acp.Cost) => ({ stats, costBefore });

  it("leaves out what the agent did not report", () => {
    assert.deepStrictEqual(turnTrace(tabWith(), "s", { stopReason: "end_turn" }, measured()), {
      stopReason: "end_turn",
      ...stats,
      sessionId: "s",
      agent: "mock 1.0",
    });
  });

  it("carries what changed and which turn it was, when known", () => {
    const changes = { files: 2, added: 3, removed: 1 };
    const trace = turnTrace(tabWith(), "s", { stopReason: "end_turn" }, { ...measured(), changes, number: 4 });
    assert.deepStrictEqual(trace.changes, changes);
    assert.strictEqual(trace.number, 4);
  });

  it("reads the turn's tokens, keeping those not reported apart from zero", () => {
    const usage = { totalTokens: 3, inputTokens: 1, outputTokens: 2, cachedReadTokens: 0, thoughtTokens: null };
    const { tokens } = turnTrace(tabWith(), "s", { stopReason: "end_turn", usage } as never, measured());
    assert.deepStrictEqual(tokens, { total: 3, input: 1, output: 2, cachedRead: 0, cachedWrite: undefined, thought: undefined });
  });

  it("works out the turn's cost from the session's total", () => {
    const tab = tabWith({ used: 10, size: 100, cost: { amount: 0.5, currency: "USD" } });
    const before = { amount: 0.25, currency: "USD" };
    assert.deepStrictEqual(turnTrace(tab, "s", { stopReason: "end_turn" }, measured(before)).cost, { turn: 0.25, session: 0.5, currency: "USD" });
    assert.deepStrictEqual(turnTrace(tab, "s", { stopReason: "end_turn" }, measured(before)).context, { used: 10, size: 100 });
  });

  it("counts all of the cost when the agent started over", () => {
    const tab = tabWith({ used: 10, size: 100, cost: { amount: 0.1, currency: "USD" } });
    assert.strictEqual(turnTrace(tab, "s", { stopReason: "end_turn" }, measured({ amount: 0.5, currency: "USD" })).cost?.turn, 0.1);
  });
});

describe("TurnTraceView", () => {
  let container: HTMLElement;
  let root: Root;
  const base = { waiting: { asks: 0, ms: 0 }, tools: { total: 0, failed: 0, kinds: {} }, subagents: 0 };
  const draw = (trace: Omit<TurnTrace, keyof typeof base> & Partial<typeof base>) =>
    act(() => root.render(createElement(TurnTraceView, { trace: { ...base, ...trace } as TurnTrace })));
  const rows = () => Object.fromEntries([...container.querySelectorAll("dl > div")].map((row) => [row.children[0]!.textContent, row.children[1]!.textContent]));

  beforeEach(() => {
    window.dispatchEvent(new MessageEvent("message", { data: { type: "l10n", lang: "en", strings: en } }));
    document.body.innerHTML = '<div id="root"></div>';
    container = document.getElementById("root")!;
    root = createRoot(container);
  });
  afterEach(() => act(() => root.unmount()));

  it("shows what was reported, and not what wasn't", () => {
    draw({ stopReason: "end_turn", durationMs: 18_000, sessionId: "s1" });
    const summary = container.querySelector("summary")!;
    assert.strictEqual(summary.querySelector(".turn-trace-part")!.textContent, "18s");
    assert.notInclude(summary.textContent!, "end_turn");
    assert.strictEqual(summary.querySelector(".turn-trace-info")!.getAttribute("title"), "Stop reason: end_turn");
    assert.isNull(container.querySelector(".turn-trace-key"));
    const labels = [...container.querySelectorAll("dt")].map((dt) => dt.textContent);
    assert.isFalse(labels.includes("Input"));
    assert.isTrue(labels.includes("Session ID"));
  });

  it("opens the log from the link", () => {
    draw({ stopReason: "end_turn", durationMs: 1000, sessionId: "s1" });
    posted.length = 0;
    act(() => container.querySelector("a")!.click());
    assert.deepStrictEqual(posted, [{ type: "showTrace" }]);
  });

  it("puts tokens and cost on the line, and a zero is a value", () => {
    draw({
      stopReason: "end_turn",
      durationMs: 1000,
      sessionId: "s1",
      tokens: { total: 12_400, input: 8100, output: 4300, cachedRead: 0 },
      cost: { turn: 0.03, session: 0.5, currency: "USD" },
    });
    const keys = [...container.querySelectorAll(".turn-trace-key")].map((el) => el.textContent);
    assert.deepStrictEqual(keys, ["$0.03", "12.4K tokens"]);
    const shown = rows();
    assert.strictEqual(shown["Cache read"], "0");
    assert.strictEqual(shown["Input"], "8,100");
    assert.isUndefined(shown["Cache write"]);
  });

  it("shows what the turn did, and leaves out what didn't happen", () => {
    draw({ stopReason: "end_turn", durationMs: 1000, sessionId: "s1" });
    const quiet = rows();
    assert.strictEqual(quiet["Tool calls"], "0");
    for (const label of ["First response", "Waiting for you", "Turn", "Subagents", "Files changed", "Cache hit"]) {
      assert.isUndefined(quiet[label]);
    }
    draw({
      stopReason: "end_turn",
      durationMs: 60_000,
      sessionId: "s1",
      firstResponseMs: 1200,
      waiting: { asks: 2, ms: 30_000 },
      tools: { total: 12, failed: 1, kinds: { edit: 3, read: 6, execute: 3 } },
      subagents: 2,
      changes: { files: 3, added: 12, removed: 4 },
      number: 4,
      tokens: { total: 27_106, input: 2, output: 485, cachedRead: 16_073, cachedWrite: 11_031 },
      context: { used: 27_591, size: 1_000_000 },
    });
    const shown = rows();
    assert.strictEqual(shown["First response"], "1.2s");
    assert.strictEqual(shown["Waiting for you"], "30s (2 requests)");
    assert.strictEqual(shown["Turn"], "#4");
    assert.strictEqual(shown["Tool calls"], "12 (1 failed): read 6 · edit 3 · execute 3");
    assert.strictEqual(shown["Subagents"], "2");
    assert.strictEqual(shown["Files changed"], "3 (+12 −4)");
    assert.strictEqual(shown["Cache hit"], "59.3%");
    assert.strictEqual(shown["Context window"], "27,591 / 1,000,000 (2.8%)");
  });
});
