// @vitest-environment happy-dom
import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { vi } from "vitest";
import type * as acp from "@agentclientprotocol/sdk";
import type { TabInfo } from "../src/chat/protocol";

vi.mock("../src/ui/chat/post", () => ({ post: () => {} }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi = () => ({
  postMessage: () => {},
  getState: () => undefined,
  setState: () => {},
});

const { AgentPanel } = await import("../src/ui/chat/agentPanel");
const { quickConfig } = await import("../src/ui/chat/sessionConfig");
const { WorkspaceBar } = await import("../src/ui/chat/workspaceControls");

const gitTab = { id: 1, named: false, pinned: false, cwd: "/w", canFork: false, branch: "main" } as TabInfo;

describe("composer controls", () => {
  let root: Root;
  const draw = (node: ReactNode) => act(() => root.render(node));
  const find = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector);

  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>';
    root = createRoot(document.getElementById("root")!);
  });

  afterEach(() => act(() => root.unmount()));

  describe("model and effort", () => {
    const panel = (summary: ReactNode) => createElement(AgentPanel, { tab: gitTab, choices: { agents: [] }, summary });
    const click = (detail: number) =>
      act(() => void find("#agent-summary")!.dispatchEvent(new MouseEvent("click", { bubbles: true, detail })));
    const model: acp.SessionConfigOption = {
      id: "m",
      name: "Model",
      type: "select",
      category: "model",
      currentValue: "o",
      options: [{ value: "o", name: "Opus" }],
    };

    it("are no button when the agent has neither", () => {
      assert.isUndefined(quickConfig([]));
      draw(panel(quickConfig([])));
      assert.isNull(find("#agent-summary"));
    });

    it("show the current value in a button that opens the panel", () => {
      draw(panel(quickConfig([model])));
      assert.include(find("#agent-summary")!.textContent, "Opus");
      assert.isNull(find("#agent-panel"));
      click(1);
      assert.isNotNull(find("#agent-panel"));
    });

    it("keep the panel a hover opened when clicked", () => {
      draw(panel(quickConfig([model])));
      act(() => void find("#agent")!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
      click(1);
      click(1);
      assert.isNotNull(find("#agent-panel"));
    });

    it("toggle the panel from the keyboard, whose click has no count", () => {
      draw(panel(quickConfig([model])));
      click(0);
      assert.isNotNull(find("#agent-panel"));
      click(0);
      assert.isNull(find("#agent-panel"));
    });
  });

  describe("model picker", () => {
    const options: ReadonlyArray<acp.SessionConfigOption> = [
      {
        id: "m",
        name: "Model",
        type: "select",
        category: "model",
        currentValue: "o",
        options: [
          { value: "o", name: "Opus" },
          { value: "s", name: "Sonnet" },
        ],
      },
      {
        id: "e",
        name: "Reasoning",
        type: "select",
        category: "thought_level",
        currentValue: "med",
        options: [
          { value: "low", name: "Low" },
          { value: "med", name: "Medium" },
        ],
      },
      {
        id: "fast",
        name: "Fast mode",
        type: "select",
        currentValue: "off",
        options: [
          { value: "off", name: "Off" },
          { value: "on", name: "On" },
        ],
      },
    ];
    const open = (onChange: (id: string, value: string) => void = () => {}) => {
      draw(
        createElement(AgentPanel, {
          tab: { ...gitTab, agentId: "a" },
          choices: {
            agents: [
              { id: "a", name: "Agent A" },
              { id: "b", name: "Agent B" },
            ],
          },
          summary: quickConfig(options),
          config: { options, loading: false, onChange },
        }),
      );
      act(() => void find("#agent-summary")!.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })));
    };
    const texts = (selector: string) => [...document.querySelectorAll(selector)].map((e) => e.textContent);

    it("lists the agents, models, levels of thinking and a fast switch", () => {
      open();
      assert.lengthOf(document.querySelectorAll(".rail-agents .rail-btn"), 2);
      assert.deepStrictEqual(texts(".picker-model .menu-label"), ["Opus", "Sonnet"]);
      assert.strictEqual(find(".picker-model[aria-selected=true]")!.textContent!.startsWith("Opus"), true);
      assert.deepStrictEqual(texts(".picker-effort-list .menu-label"), ["Low", "Medium"]);
      assert.isNotNull(find(".picker-segments"));
    });

    it("filters the models by the search", () => {
      open();
      const input = find<HTMLInputElement>(".picker-search input")!;
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "son");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      assert.deepStrictEqual(texts(".picker-model .menu-label"), ["Sonnet"]);
    });

    it("picks a model, a level and the fast mode", () => {
      const picked: Array<[string, string]> = [];
      open((id, value) => picked.push([id, value]));
      const rows = document.querySelectorAll<HTMLElement>(".picker-model");
      act(() => rows[1]!.click());
      act(() => document.querySelectorAll<HTMLElement>(".picker-effort-list button")[0]!.click());
      act(() => document.querySelectorAll<HTMLElement>(".picker-segments button")[1]!.click());
      assert.deepStrictEqual(picked, [
        ["m", "s"],
        ["e", "low"],
        ["fast", "on"],
      ]);
    });
  });

  describe("model picker rail", () => {
    it("shows another agent's models on hover without switching to it", async () => {
      vi.useFakeTimers();
      try {
        draw(
          createElement(AgentPanel, {
            tab: { ...gitTab, agentId: "a" },
            choices: {
              agents: [
                { id: "a", name: "Agent A" },
                { id: "b", name: "Agent B" },
              ],
            },
            summary: "s",
            config: { options: [], loading: false, onChange: () => {} },
          }),
        );
        act(() => void find("#agent-summary")!.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })));
        const b = document.querySelectorAll<HTMLElement>(".rail-agents .rail-btn")[1]!;
        act(() => void b.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
        act(() => void vi.advanceTimersByTime(200));
        assert.strictEqual(b.getAttribute("aria-pressed"), "true");
        assert.isNotNull(find(".picker-other"));
        assert.isNotNull(find(".config-loading"));
        await act(async () => {
          window.dispatchEvent(
            new MessageEvent("message", {
              data: {
                type: "attemptOptions",
                agentId: "b",
                model: "",
                options: { models: [{ value: "x", name: "Xeno" }], efforts: [], fastMode: false },
              },
            }),
          );
        });
        assert.deepStrictEqual(
          [...document.querySelectorAll(".picker-model .menu-label")].map((e) => e.textContent),
          ["Xeno"],
        );
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("worktree checkbox", () => {
    const bar = (tab: TabInfo, opts: { comparing?: boolean; editing?: boolean } = {}) =>
      createElement(WorkspaceBar, {
        tab,
        busy: false,
        comparing: opts.comparing ?? false,
        editing: opts.editing ?? false,
      });
    const box = () => find<HTMLInputElement>("#workspace-bar #worktree input");

    it("sits in the bar beside the branch", () => {
      draw(bar(gitTab));
      assert.include(find("#workspace-bar .workspace-branch")!.textContent, "main");
      assert.isFalse(box()!.disabled);
    });

    it("is ticked and fixed during a comparison", () => {
      draw(bar(gitTab, { comparing: true }));
      assert.isTrue(box()!.checked);
      assert.isTrue(box()!.disabled);
    });

    it("is gone while editing a sent message and once the tab has a worktree", () => {
      draw(bar(gitTab, { editing: true }));
      assert.isNull(box());
      draw(bar({ ...gitTab, worktree: { root: "/t", base: "/w", branch: "b" } } as TabInfo));
      assert.isNull(box());
    });
  });
});
