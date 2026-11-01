import { assert, beforeEach, describe, it } from "@effect/vitest";
import { statusBarView } from "../src/chat/statusBar";
import { __test } from "./stubs/vscode";

beforeEach(() => __test.reset());

const idle = { agent: "Claude", model: "Opus", waiting: 0, finished: 0, running: 0 };

describe("statusBarView", () => {
  it("shows the agent and model of an idle chat", () => {
    const view = statusBarView(idle);
    assert.strictEqual(view.text, "$(comment-discussion) Claude · Opus");
    assert.isFalse(view.warning);
    assert.include(view.tooltip, "Model: Opus");
    assert.include(view.tooltip, "Ready");
    assert.include(view.tooltip, "Click to show the chat");
  });

  it("leaves out a model the agent doesn't report", () => {
    assert.strictEqual(statusBarView({ ...idle, model: undefined }).text, "$(comment-discussion) Claude");
    assert.strictEqual(statusBarView({ ...idle, agent: undefined, model: undefined }).text, "$(comment-discussion) No agent");
  });

  it("spins while a turn runs", () => {
    const view = statusBarView({ ...idle, running: 2 });
    assert.strictEqual(view.text, "$(loading~spin) Claude · Opus");
    assert.include(view.tooltip, "Running: 2");
    assert.notInclude(view.tooltip, "Ready");
  });

  it("warns while a permission waits, above everything else", () => {
    const view = statusBarView({ ...idle, waiting: 1, finished: 1, running: 1 });
    assert.strictEqual(view.text, "$(bell-dot) Claude · Opus");
    assert.isTrue(view.warning);
    assert.include(view.tooltip, "Waiting for your approval: 1");
    assert.include(view.tooltip, "Click to show the conversation that needs you");
  });

  it("rings for a turn that finished unseen", () => {
    const view = statusBarView({ ...idle, finished: 1 });
    assert.strictEqual(view.text, "$(bell) Claude · Opus");
    assert.isFalse(view.warning);
  });

  it("follows the language setting", () => {
    __test.setSetting("codeAcp.language", "vi");
    const view = statusBarView({ ...idle, waiting: 1 });
    assert.include(view.tooltip, "Đang chờ bạn cho phép: 1");
  });
});
