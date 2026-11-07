import { assert, beforeEach, describe, it } from "@effect/vitest";
import { statusBarView } from "../src/chat/statusBar";
import { __test } from "./stubs/vscode";

beforeEach(() => __test.reset());

const idle = { agent: "Claude", model: "Opus", effort: "High", waiting: 0, finished: 0, running: 0 };

describe("statusBarView", () => {
  it("shows only an icon for an idle chat, the agent, model and effort in the tooltip", () => {
    const view = statusBarView(idle);
    assert.strictEqual(view.text, "$(comment-discussion)");
    assert.isFalse(view.warning);
    assert.include(view.tooltip, "Agent: Claude");
    assert.include(view.tooltip, "Model: Opus");
    assert.include(view.tooltip, "Effort: High");
    assert.include(view.tooltip, "Ready");
    assert.include(view.tooltip, "Click to show the chat");
  });

  it("leaves out a model or effort the agent doesn't report", () => {
    const none = statusBarView({ ...idle, agent: undefined, model: undefined, effort: undefined });
    assert.strictEqual(none.text, "$(comment-discussion)");
    assert.include(none.tooltip, "No agent");
    assert.notInclude(none.tooltip, "Model:");
    assert.notInclude(none.tooltip, "Effort:");
  });

  it("spins while a turn runs", () => {
    const view = statusBarView({ ...idle, running: 2 });
    assert.strictEqual(view.text, "$(loading~spin)");
    assert.include(view.tooltip, "Running: 2");
    assert.notInclude(view.tooltip, "Ready");
  });

  it("spins while a tab runs something in the background, with no turn running", () => {
    const view = statusBarView({ ...idle, background: 1 });
    assert.strictEqual(view.text, "$(loading~spin)");
    assert.include(view.tooltip, "Background tasks: 1");
    assert.notInclude(view.tooltip, "Running:");
    assert.notInclude(view.tooltip, "Ready");
  });

  it("warns while a permission waits, above everything else", () => {
    const view = statusBarView({ ...idle, waiting: 1, finished: 1, running: 1 });
    assert.strictEqual(view.text, "$(bell-dot)");
    assert.isTrue(view.warning);
    assert.include(view.tooltip, "Waiting for you: 1");
    assert.include(view.tooltip, "Click to show the conversation that needs you");
  });

  it("rings for a turn that finished unseen", () => {
    const view = statusBarView({ ...idle, finished: 1 });
    assert.strictEqual(view.text, "$(bell)");
    assert.isFalse(view.warning);
  });

  it("follows the language setting", () => {
    __test.setSetting("kdCode.language", "vi");
    const view = statusBarView({ ...idle, waiting: 1 });
    assert.include(view.tooltip, "Đang chờ bạn: 1");
  });
});
