// @vitest-environment happy-dom
import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { vi } from "vitest";
import type * as acp from "@agentclientprotocol/sdk";
import type { TabInfo } from "../src/chat/protocol";

vi.mock("../src/ui/chat/post", () => ({ post: () => {} }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
    const click = (detail: number) => act(() => void find("#agent-summary")!.dispatchEvent(new MouseEvent("click", { bubbles: true, detail })));
    const model: acp.SessionConfigOption = { id: "m", name: "Model", type: "select", category: "model", currentValue: "o", options: [{ value: "o", name: "Opus" }] };

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

  describe("worktree checkbox", () => {
    const bar = (tab: TabInfo, opts: { comparing?: boolean; editing?: boolean } = {}) =>
      createElement(WorkspaceBar, { tab, busy: false, comparing: opts.comparing ?? false, editing: opts.editing ?? false });
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
