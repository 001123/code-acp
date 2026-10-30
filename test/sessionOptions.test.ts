import type * as acp from "@agentclientprotocol/sdk";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import type { AcpAgent } from "../src/acpClient";
import { agentOptions, configureSession } from "../src/sessionOptions";

const select = (id: string, category: string | undefined, currentValue: string, values: string[]): acp.SessionConfigOption =>
  ({ id, name: id, category, type: "select", currentValue, options: values.map((value) => ({ value, name: value.toUpperCase() })) }) as acp.SessionConfigOption;

/** Codex-like options: the efforts depend on the model. */
const optionsFor = (model: string, effort: string, fast: string) => [
  select("model", "model", model, ["big", "small"]),
  // Like Claude's, the levels start with the agent's own "default".
  select("reasoning_effort", "thought_level", effort, model === "small" ? ["default", "minimal", "low"] : ["default", "low", "medium", "high"]),
  select("fast-mode", "model_config", fast, ["off", "on"]),
];

/** An agent that records `session/set_config_option` and answers with the options as set. */
const fakeAgent = () => {
  const calls: Array<[string, string]> = [];
  let current = { model: "big", reasoning_effort: "high", "fast-mode": "off" } as Record<string, string>;
  const agent = {
    setConfigOption: (_: string, id: string, value: string) =>
      Effect.sync(() => {
        calls.push([id, value]);
        current = { ...current, [id]: value };
        return { configOptions: optionsFor(current.model!, current.reasoning_effort!, current["fast-mode"]!) };
      }),
  } as unknown as AcpAgent;
  const session = { sessionId: "s1", configOptions: optionsFor("big", "high", "off") } as acp.NewSessionResponse;
  return { agent, session, calls };
};

describe("configureSession", () => {
  it.effect("sets the model first, then the least effort of that model, then fast mode", () =>
    Effect.gen(function* () {
      const { agent, session, calls } = fakeAgent();
      const missing: string[] = [];
      yield* configureSession(agent, session, { model: "SMALL", effort: "lowest", fastMode: "on" }, (what) => missing.push(what));
      assert.deepStrictEqual(calls, [
        ["model", "small"],
        ["reasoning_effort", "minimal"],
        ["fast-mode", "on"],
      ]);
      assert.deepStrictEqual(missing, []);
    }),
  );

  it.effect("keeps the defaults when nothing is asked for, and reports what the agent lacks", () =>
    Effect.gen(function* () {
      const { agent, session, calls } = fakeAgent();
      const missing: string[] = [];
      yield* configureSession(agent, session, { model: "", effort: "", fastMode: "default" });
      yield* configureSession(agent, session, { model: "huge", effort: "ultra", fastMode: "off" }, (what, value) => missing.push(`${what}:${value}`));
      assert.deepStrictEqual(calls, []);
      assert.deepStrictEqual(missing, ["model:huge", "effort:ultra"]);
    }),
  );
});

describe("agentOptions", () => {
  it("lists the models, the efforts and whether there is a fast mode", () => {
    const options = agentOptions(optionsFor("big", "high", "off"));
    assert.deepStrictEqual(options.models.map((m) => m.value), ["big", "small"]);
    assert.strictEqual(options.models[0]!.name, "BIG");
    assert.deepStrictEqual(options.efforts.map((m) => m.value), ["low", "medium", "high"]);
    assert.isTrue(options.fastMode);
    assert.isFalse(options.defaultFastMode);
    assert.deepStrictEqual(agentOptions(undefined), { models: [], efforts: [], fastMode: false });
  });
});
