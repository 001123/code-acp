// @vitest-environment happy-dom
import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { CatalogAgent, CatalogState } from "../src/agentCatalog";
import type { DoctorResult, DoctorState } from "../src/doctor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const posted: Array<unknown> = [];
(globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi = () => ({
  postMessage: (message: unknown) => void posted.push(message),
  getState: () => undefined,
  setState: () => {},
});
const { AgentPicker, AgentSetup, checkOutcome, needsSetup, suggestedAgents } =
  await import("../src/ui/chat/agentSetup");

const agent = (id: string, extra: Partial<CatalogAgent> = {}): CatalogAgent => ({
  id,
  name: id,
  version: "1.0.0",
  description: `${id} description`,
  kind: "npx",
  active: false,
  ...extra,
});
const state = (agents: CatalogAgent[], extra: Partial<CatalogState> = {}): CatalogState => ({
  agents,
  loading: false,
  ...extra,
});
const three = [agent("other"), agent("antigravity-acp", { kind: "binary" }), agent("codex-acp"), agent("claude-acp")];

describe("suggestedAgents", () => {
  it("gives Claude, Codex and Antigravity in that order", () => {
    assert.deepStrictEqual(
      suggestedAgents(three).map((a) => a.id),
      ["claude-acp", "codex-acp", "antigravity-acp"],
    );
  });

  it("leaves out what this machine can't install", () => {
    const agents = [agent("claude-acp"), agent("antigravity-acp", { kind: undefined })];
    assert.deepStrictEqual(
      suggestedAgents(agents).map((a) => a.id),
      ["claude-acp"],
    );
  });
});

describe("needsSetup", () => {
  const installed = [{ id: "claude-acp", name: "Claude" }];

  it("holds the chat back until there is an agent", () => {
    assert.isTrue(needsSetup([], state([])));
    assert.isFalse(needsSetup(installed, state([])));
  });

  it("waits for the installs still running", () => {
    assert.isTrue(needsSetup(installed, state([agent("codex-acp", { busy: "Installing…" })])));
  });
});

describe("AgentPicker", () => {
  let root: Root;
  const render = (catalog: CatalogState) => act(() => root.render(createElement(AgentPicker, { catalog })));
  const buttons = () => [...document.querySelectorAll<HTMLButtonElement>("#agent-setup button")];
  const button = (text: string) => buttons().find((b) => b.textContent === text)!;
  const boxes = () => [...document.querySelectorAll<HTMLInputElement>("#agent-setup input")];

  beforeEach(() => {
    posted.length = 0;
    document.body.innerHTML = '<div id="root"></div>';
    root = createRoot(document.getElementById("root")!);
  });
  afterEach(() => act(() => root.unmount()));

  it("loads the registry when it appears", () => {
    render(state([], { loading: true }));
    assert.deepStrictEqual(posted, [{ type: "catalogLoad" }]);
  });

  it("needs one agent picked to continue, and installs what is picked", () => {
    render(state(three));
    posted.length = 0;
    assert.strictEqual(boxes().length, 3);
    assert.isTrue(button("chat.setup.continue").disabled);

    act(() => boxes()[0]!.click());
    act(() => boxes()[2]!.click());
    assert.isFalse(button("chat.setup.continue").disabled);
    act(() => button("chat.setup.continue").click());
    assert.deepStrictEqual(posted, [
      { type: "catalogInstall", id: "claude-acp" },
      { type: "catalogInstall", id: "antigravity-acp" },
    ]);
  });

  it("locks the picks while installing and shows the progress", () => {
    render(state([agent("claude-acp", { busy: "npm install" }), agent("codex-acp")]));
    assert.isTrue(boxes().every((box) => box.disabled));
    assert.isTrue(button("manager.installing").disabled);
    assert.include(document.querySelector(".setup-agent")!.textContent, "npm install");
  });

  it("opens the agent manager for the other agents", () => {
    render(state(three));
    posted.length = 0;
    act(() => button("chat.setup.more").click());
    assert.deepStrictEqual(posted, [{ type: "manageAgents" }]);
  });

  it("offers another try when the registry can't be read", () => {
    render(state([], { error: "offline" }));
    posted.length = 0;
    assert.include(document.querySelector("#agent-setup")!.textContent, "offline");
    act(() => button("chat.retry").click());
    assert.deepStrictEqual(posted, [{ type: "catalogRefresh" }]);
  });
});

const tools = (results: Record<string, DoctorResult | undefined>, running = false): DoctorState => ({
  rows: Object.entries(results).map(([id, result]) => ({ id, group: "tools", label: id, result })),
  running,
});
const ok: DoctorResult = { status: "ok", description: "1.0.0" };
const missing = (status: "warning" | "error"): DoctorResult => ({
  status,
  detail: "Not found",
  fix: { type: "open", url: "https://example.com" },
});

describe("checkOutcome", () => {
  it("is still checking before the first result and during a run", () => {
    assert.strictEqual(checkOutcome({ rows: [], running: false }), "checking");
    assert.strictEqual(checkOutcome(tools({ node: ok, npm: undefined }, true)), "checking");
    assert.strictEqual(checkOutcome(tools({ node: ok }, true)), "checking");
  });

  it("fails on a needed tool, warns on an optional one, and passes otherwise", () => {
    assert.strictEqual(checkOutcome(tools({ node: missing("error"), git: missing("warning") })), "failed");
    assert.strictEqual(checkOutcome(tools({ node: ok, git: missing("warning") })), "warned");
    assert.strictEqual(checkOutcome(tools({ node: ok, git: ok })), "passed");
  });
});

describe("AgentSetup", () => {
  let root: Root;
  const catalog = state(three);
  const render = (doctor: DoctorState) => act(() => root.render(createElement(AgentSetup, { catalog, doctor })));
  const button = (text: string) =>
    [...document.querySelectorAll<HTMLButtonElement>("#agent-setup button")].find((b) => b.textContent === text);
  const picker = () => document.querySelector(".setup-agent");

  beforeEach(() => {
    posted.length = 0;
    document.body.innerHTML = '<div id="root"></div>';
    root = createRoot(document.getElementById("root")!);
  });
  afterEach(() => act(() => root.unmount()));

  it("checks the tools first, without offering agents or loading them", () => {
    render({ rows: [], running: false });
    assert.deepStrictEqual(posted, [{ type: "doctorRun" }]);
    assert.isNull(picker());
    assert.include(document.querySelector("#agent-setup")!.textContent, "doctor.checking");
  });

  it("goes on to the agents by itself when everything passes", () => {
    render(tools({ node: ok, npm: ok, uv: ok, git: ok }));
    assert.isNotNull(picker());
    assert.deepInclude(posted, { type: "catalogLoad" });
  });

  it("holds the agents back when a needed tool is missing, offering the download and another check", () => {
    render(tools({ node: missing("error"), npm: ok }));
    assert.isNull(picker());
    assert.isUndefined(button("chat.setup.next"));
    posted.length = 0;
    act(() => button("doctor.fix.open")!.click());
    act(() => button("doctor.runAgain")!.click());
    assert.deepStrictEqual(posted, [{ type: "doctorFix", id: "node" }, { type: "doctorRun" }]);
  });

  it("lets the user go on past an optional tool, after showing it", () => {
    render(tools({ node: ok, git: missing("warning") }));
    assert.isNull(picker());
    act(() => button("chat.setup.next")!.click());
    assert.isNotNull(picker());
  });
});
