import type * as acp from "@agentclientprotocol/sdk";
import { Option, Schema } from "effect";
import type * as vscode from "vscode";
import { fastOption, fastValue, modelOption, thoughtOption, type Wanted } from "../sessionOptions";

const KEY = "codeAcp.lastSessionOptions";

const Picked = Schema.Struct({
  model: Schema.optional(Schema.String),
  effort: Schema.optional(Schema.String),
  fastMode: Schema.optional(Schema.Literals(["on", "off"])),
});
type Picked = typeof Picked.Type;

const Saved = Schema.Record(Schema.String, Picked);

/** The model, level of thinking and fast mode last picked in a chat, by agent id: sessions of that agent start or reopen with them. */
export class LastOptions {
  constructor(private readonly state: vscode.Memento) {}

  private get all(): Record<string, Picked> {
    return Option.getOrElse(Schema.decodeUnknownOption(Saved)(this.state.get(KEY)), () => ({}));
  }

  /** What a new session of the agent should set; undefined when nothing was picked. */
  wanted(agentId: string): Wanted | undefined {
    const picked = this.all[agentId];
    return picked && { model: picked.model ?? "", effort: picked.effort ?? "", fastMode: picked.fastMode ?? "default" };
  }

  /** Keeps `value` when `configId` is the model, level of thinking or fast mode of `options` (the session's before the change). */
  picked(agentId: string, options: ReadonlyArray<acp.SessionConfigOption> | null | undefined, configId: string, value: string): Thenable<void> | undefined {
    const change = this.change(options, configId, value);
    const all = this.all;
    const current = all[agentId] ?? {};
    if (!change || Object.entries(change).every(([k, v]) => current[k as keyof Picked] === v)) {
      return undefined;
    }
    return this.state.update(KEY, { ...all, [agentId]: { ...current, ...change } });
  }

  private change(options: ReadonlyArray<acp.SessionConfigOption> | null | undefined, configId: string, value: string): Picked | undefined {
    if (modelOption(options)?.id === configId) {
      return { model: value };
    }
    if (thoughtOption(options)?.id === configId) {
      return { effort: value };
    }
    const fast = fastOption(options);
    if (fast?.id === configId) {
      const fastMode = value === fastValue(fast, true) ? "on" : value === fastValue(fast, false) ? "off" : undefined;
      return fastMode && { fastMode };
    }
    return undefined;
  }
}
