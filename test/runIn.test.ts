import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, ManagedRuntime } from "effect";
import { AgentStartError } from "../src/acpClient";
import { runIn, type AppRuntime } from "../src/runtime";

const makeRuntime = () => ManagedRuntime.make(Layer.empty) as unknown as AppRuntime;

describe("runIn", () => {
  it.live("ignores an effect interrupted because the runtime is disposed", () =>
    Effect.promise(async () => {
      const runtime = makeRuntime();
      const errors: string[] = [];
      const running = runIn(runtime, Effect.never, (message) => void errors.push(message));
      // Lets the fiber start, so that the disposal interrupts it.
      await new Promise((resolve) => setTimeout(resolve, 5));
      await runtime.dispose();
      await running;
      assert.deepStrictEqual(errors, []);
    }),
  );

  it.live("reports what can't run on a disposed runtime instead of rejecting", () =>
    Effect.promise(async () => {
      const runtime = makeRuntime();
      await runtime.dispose();
      const errors: string[] = [];
      await runIn(runtime, Effect.void, (message) => void errors.push(message));
      assert.strictEqual(errors.length, 1);
    }),
  );

  it.live("passes failures to the error handler", () =>
    Effect.promise(async () => {
      const runtime = makeRuntime();
      const errors: string[] = [];
      await runIn(
        runtime,
        Effect.fail(new AgentStartError({ message: "broken" })),
        (message) => void errors.push(message),
      );
      await runtime.dispose();
      assert.deepStrictEqual(errors, ["broken"]);
    }),
  );
});
