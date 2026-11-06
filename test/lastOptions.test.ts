import type * as acp from "@agentclientprotocol/sdk";
import { assert, describe, it } from "@effect/vitest";
import type * as vscode from "vscode";
import { LastOptions } from "../src/chat/lastOptions";

const memento = (): vscode.Memento => {
  const values = new Map<string, unknown>();
  return {
    keys: () => [...values.keys()],
    get: (key: string) => values.get(key),
    update: (key: string, value: unknown) => {
      values.set(key, value);
      return Promise.resolve();
    },
  } as vscode.Memento;
};

const select = (id: string, category: string | undefined, values: string[]) =>
  ({
    id,
    name: id,
    category,
    type: "select",
    currentValue: values[0],
    options: values.map((value) => ({ value, name: value })),
  }) as acp.SessionConfigOption;

const options = [
  select("model", "model", ["opus", "sonnet"]),
  select("effort", "thought_level", ["low", "high"]),
  select("fast-mode", "model_config", ["off", "on"]),
  select("mode", "mode", ["default", "plan"]),
];

describe("LastOptions", () => {
  it("keeps the model, effort and fast mode picked, by agent", async () => {
    const last = new LastOptions(memento());
    await last.picked("claude", options, "model", "sonnet");
    await last.picked("claude", options, "effort", "high");
    await last.picked("claude", options, "fast-mode", "on");
    await last.picked("codex", options, "effort", "low");
    assert.deepStrictEqual(last.wanted("claude"), { model: "sonnet", effort: "high", fastMode: "on" });
    assert.deepStrictEqual(last.wanted("codex"), { model: "", effort: "low", fastMode: "default" });
    assert.isUndefined(last.wanted("gemini"));
  });

  it("ignores other options and unchanged values", async () => {
    const last = new LastOptions(memento());
    assert.isUndefined(last.picked("claude", options, "mode", "plan"));
    assert.isUndefined(last.wanted("claude"));
    await last.picked("claude", options, "effort", "high");
    assert.isUndefined(last.picked("claude", options, "effort", "high"));
  });
});
