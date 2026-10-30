import * as NodeChildProcessSpawner from "@effect/platform-node-shared/NodeChildProcessSpawner";
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import * as NodePath from "@effect/platform-node-shared/NodePath";
import { Cause, Context, Effect, Layer, Logger, ManagedRuntime, Predicate, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import * as vscode from "vscode";
import { AgentManager } from "./agentManager";
import { AgentUpdates } from "./agentUpdates";
import { ShadowGit } from "./checkpoints";
import { ClaudeSettings } from "./claudeSettings";
import { CommitMessage } from "./commitMessage";
import { Completions } from "./completions";
import { Problems } from "./problems";
import { AcpRegistry } from "./registry";
import { TerminalContext } from "./terminalContext";
import { UsageLedger } from "./usageLedger";

export class ExtensionCtx extends Context.Service<ExtensionCtx, vscode.ExtensionContext>()("code-acp/ExtensionCtx") {}

/** The "Code ACP" output channel; raw process output goes here, Effect logs too. */
export class Output extends Context.Service<Output, vscode.OutputChannel>()("code-acp/Output") {}

/** A rejected VS Code API call (file system, settings, UI). */
export class VscodeError extends Schema.TaggedError<VscodeError>()("VscodeError", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

/** Human-readable message for any error value. */
export function messageOf(error: unknown): string {
  if (Predicate.hasProperty(error, "message") && Predicate.isString(error.message)) {
    return error.message;
  }
  return Predicate.isString(error) ? error : JSON.stringify(error);
}

/** Lifts a VS Code Thenable into an Effect, failing with VscodeError when it rejects. */
export const thenable = <A>(evaluate: () => Thenable<A>): Effect.Effect<A, VscodeError> =>
  Effect.tryPromise({
    try: () => Promise.resolve(evaluate()),
    catch: (cause) => new VscodeError({ message: messageOf(cause), cause }),
  });

/** Effect logs as plain lines in the output channel; non-info levels get a "[level]" prefix. */
const outputLogger = (channel: vscode.OutputChannel) =>
  Logger.make(({ logLevel, message }) => {
    const parts = Array.isArray(message) ? message : [message];
    const text = parts.map((part) => (Predicate.isString(part) ? part : messageOf(part))).join(" ");
    const prefix = logLevel === "Info" ? "" : `[${logLevel.toLowerCase()}] `;
    channel.appendLine(`${prefix}${text}`);
  });

const appLayer = (context: vscode.ExtensionContext, channel: vscode.OutputChannel) => {
  const platform = NodeChildProcessSpawner.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
  );
  const base = Layer.mergeAll(
    Layer.succeed(ExtensionCtx, context),
    Layer.succeed(Output, channel),
    platform,
    FetchHttpClient.layer,
    Logger.layer([outputLogger(channel)]),
  );
  const services = Layer.mergeAll(AgentManager.layer, AcpRegistry.layer, ClaudeSettings.layer, Completions.layer, Problems.layer, TerminalContext.layer, ShadowGit.layer, UsageLedger.layer).pipe(Layer.provideMerge(base));
  return Layer.mergeAll(CommitMessage.layer, AgentUpdates.layer).pipe(Layer.provideMerge(services));
};

export type AppServices = Layer.Success<ReturnType<typeof appLayer>>;
export type AppRuntime = ManagedRuntime.ManagedRuntime<AppServices, never>;

export function makeRuntime(context: vscode.ExtensionContext, channel: vscode.OutputChannel): AppRuntime {
  return ManagedRuntime.make(appLayer(context, channel));
}

/**
 * Runs an effect from a VS Code callback. Failures and defects go to `onError`; interruptions are
 * expected (restart, dispose) and ignored.
 */
export function runIn<E>(
  runtime: AppRuntime,
  effect: Effect.Effect<void, E, AppServices>,
  onError: (message: string) => void,
): Promise<void> {
  return runtime.runPromise(
    effect.pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.void;
        }
        const message = messageOf(Cause.squash(cause));
        // Defects are bugs: keep the stack trace in the log.
        return Effect.logError(Cause.hasDies(cause) ? Cause.pretty(cause) : message).pipe(
          Effect.andThen(Effect.sync(() => onError(message))),
        );
      }),
    ),
  );
}
