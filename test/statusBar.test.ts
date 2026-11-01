import { assert, beforeEach, describe, it } from "@effect/vitest";
import { statusBarView } from "../src/chat/statusBar";
import { __test } from "./stubs/vscode";

beforeEach(() => __test.reset());

const idle = { agent: "Claude", model: "Opus", effort: "High", waiting: 0, finished: 0, running: 0 };

describe("statusBarView", () => {
  it("shows the model and effort of an idle chat, the agent in the tooltip", () => {
    const view = statusBarView(idle);
    assert.strictEqual(view.text, "$(comment-discussion) Opus · High");
    assert.isFalse(view.warning);
    assert.include(view.tooltip, "Agent: Claude");
    assert.include(view.tooltip, "Model: Opus");
    assert.include(view.tooltip, "Effort: High");
    assert.include(view.tooltip, "Ready");
    assert.include(view.tooltip, "Click to show the chat");
  });

  it("leaves out a model or effort the agent doesn't report", () => {
    assert.strictEqual(statusBarView({ ...idle, effort: undefined }).text, "$(comment-discussion) Opus");
    assert.strictEqual(statusBarView({ ...idle, model: undefined }).text, "$(comment-discussion) High");
    const none = statusBarView({ ...idle, agent: undefined, model: undefined, effort: undefined });
    assert.strictEqual(none.text, "$(comment-discussion)");
    assert.include(none.tooltip, "No agent");
  });

  it("spins while a turn runs", () => {
    const view = statusBarView({ ...idle, running: 2 });
    assert.strictEqual(view.text, "$(loading~spin) Opus · High");
    assert.include(view.tooltip, "Running: 2");
    assert.notInclude(view.tooltip, "Ready");
  });

  it("warns while a permission waits, above everything else", () => {
    const view = statusBarView({ ...idle, waiting: 1, finished: 1, running: 1 });
    assert.strictEqual(view.text, "$(bell-dot) Opus · High");
    assert.isTrue(view.warning);
    assert.include(view.tooltip, "Waiting for you: 1");
    assert.include(view.tooltip, "Click to show the conversation that needs you");
  });

  it("rings for a turn that finished unseen", () => {
    const view = statusBarView({ ...idle, finished: 1 });
    assert.strictEqual(view.text, "$(bell) Opus · High");
    assert.isFalse(view.warning);
  });

  it("follows the language setting", () => {
    __test.setSetting("codeAcp.language", "vi");
    const view = statusBarView({ ...idle, waiting: 1 });
    assert.include(view.tooltip, "Đang chờ bạn: 1");
  });
});
