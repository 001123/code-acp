import type * as acp from "@agentclientprotocol/sdk";
import { Effect } from "effect";
import type { AcpAgent } from "./acpClient";

/** A value of one of the agent's session options. */
export interface Choice {
  readonly value: string;
  readonly name: string;
  readonly description?: string;
}

/** What a feature running its own sessions (such as commit messages) may pick; see `configureSession`. */
export interface AgentOptions {
  readonly models: ReadonlyArray<Choice>;
  /** Levels of thinking of the model asked for (else the default one), the least first. */
  readonly efforts: ReadonlyArray<Choice>;
  /** Whether the agent has a fast mode to turn on or off. */
  readonly fastMode: boolean;
  /** Whether its fast mode is on in a new session. */
  readonly defaultFastMode?: boolean;
}

/** The effort setting that picks the least thinking the agent offers; empty keeps the agent's default. */
export const LOWEST_EFFORT = "lowest";

/** The fast mode setting: "default" leaves the agent's own. */
export type FastMode = "default" | "on" | "off";

/** What `configureSession` sets; empty strings and "default" keep the agent's defaults. */
export interface Wanted {
  readonly model: string;
  readonly effort: string;
  readonly fastMode: FastMode;
}

type Options = ReadonlyArray<acp.SessionConfigOption> | null | undefined;
type Select = acp.SessionConfigOption & { type: "select" };

const findSelect = (options: Options, test: (o: Select) => boolean) =>
  options?.find((o): o is Select => o.type === "select" && test(o));

/** The session's model picker: the select option of category "model" (or id "model"). */
export const modelOption = (options: Options) => findSelect(options, (o) => o.category === "model" || o.id === "model");

/** The session's levels of thinking (category "thought_level"). */
export const thoughtOption = (options: Options) => findSelect(options, (o) => o.category === "thought_level");

/** A fast mode switch, such as Codex's "fast-mode". */
export const fastOption = (options: Options) => findSelect(options, (o) => /fast/i.test(o.id));

export const choicesOf = (option: Select): Array<Choice> =>
  option.options
    .flatMap((o) => ("options" in o ? o.options : [o]))
    .map((o) => ({ value: o.value, name: o.name, ...(o.description ? { description: o.description } : {}) }));

/** The choice named `wanted`, by value or else by name, ignoring case. */
export const findChoice = (option: Select, wanted: string): Choice | undefined => {
  const w = wanted.trim().toLowerCase();
  return choicesOf(option).find((c) => c.value.toLowerCase() === w || c.name.toLowerCase() === w);
};

/** The real levels of thinking of `option`, the least first: without the agent's own "default" (or "auto") entry. */
export const levelsOf = (option: Select): Array<Choice> => choicesOf(option).filter((c) => !/^(default|auto)$/i.test(c.value));

/** The value of a fast mode switch that turns it on (or off). */
const fastValue = (option: Select, on: boolean): string | undefined =>
  choicesOf(option).find((c) => (on ? /^(on|true|enabled?)$/i : /^(off|false|disabled?)$/i).test(c.value))?.value;

/** What `options` offer to pick. */
export const agentOptions = (options: Options): AgentOptions => {
  const model = modelOption(options);
  const thought = thoughtOption(options);
  const fast = fastOption(options);
  const hasFast = !!fast && fastValue(fast, true) !== undefined && fastValue(fast, false) !== undefined;
  return {
    models: model ? choicesOf(model) : [],
    efforts: thought ? levelsOf(thought) : [],
    fastMode: hasFast,
    ...(hasFast ? { defaultFastMode: fast.currentValue === fastValue(fast, true) } : {}),
  };
};

/**
 * Sets the model, then the effort (the model may come with its own levels) and the fast mode of a new session. A
 * setting the agent does not offer is skipped and reported with `onMissing`. Gives the session's options as set.
 */
export const configureSession = Effect.fn("configureSession")(function* (
  agent: AcpAgent,
  session: acp.NewSessionResponse,
  wanted: Wanted,
  onMissing: (what: "model" | "effort", value: string) => void = () => {},
) {
  let options: Options = session.configOptions;
  const set = (option: Select, value: string) =>
    option.currentValue === value
      ? Effect.void
      : agent.setConfigOption(session.sessionId, option.id, value).pipe(
          Effect.map((response) => {
            options = response.configOptions ?? options;
          }),
        );

  if (wanted.model.trim()) {
    const option = modelOption(options);
    const match = option && findChoice(option, wanted.model);
    if (option && match) yield* set(option, match.value);
    else onMissing("model", wanted.model);
  }
  if (wanted.effort.trim()) {
    const option = thoughtOption(options);
    const match = option && (wanted.effort === LOWEST_EFFORT ? levelsOf(option)[0] : findChoice(option, wanted.effort));
    if (option && match) yield* set(option, match.value);
    else if (wanted.effort !== LOWEST_EFFORT) onMissing("effort", wanted.effort);
  }
  if (wanted.fastMode !== "default") {
    const option = fastOption(options);
    const value = option && fastValue(option, wanted.fastMode === "on");
    if (option && value) yield* set(option, value);
  }
  return options;
});
