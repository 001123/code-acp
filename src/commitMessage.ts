import type * as acp from "@agentclientprotocol/sdk";
import { Context, Deferred, Effect, Layer, Predicate, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as vscode from "vscode";
import * as os from "node:os";
import { spawnAgent, type AcpAgent } from "./acpClient";
import { AgentManager } from "./agentManager";
import { t } from "./i18n";
import { messageOf, Output, thenable } from "./runtime";
import { readSettings } from "./settings";

/** A repository whose commit message box we fill: a `vscode.SourceControl` or a git extension repository. */
export interface CommitTarget {
  readonly rootUri: vscode.Uri;
  readonly inputBox: { value: string };
}

/** The part of the `vscode.git` extension API used here (see extensions/git/src/api/git.d.ts). */
interface GitApi {
  readonly repositories: ReadonlyArray<CommitTarget>;
}
interface GitExtension {
  getAPI(version: 1): GitApi;
}

export class CommitMessageError extends Schema.TaggedError<CommitMessageError>()("CommitMessageError", {
  message: Schema.String,
}) {}

/** Context key that swaps the SCM title button to "stop" while a message is being generated. */
const GENERATING_KEY = "codeAcp.generatingCommitMessage";
/** Keeps the prompt within what agents accept comfortably. */
const MAX_DIFF_CHARS = 80_000;
const CANCELLED: acp.RequestPermissionResponse = { outcome: { outcome: "cancelled" } };

/** A model the commit agent offers. */
export interface CommitModel {
  readonly value: string;
  readonly name: string;
}

/** The session's model picker: the select option of category "model" (or id "model"). */
const modelOption = (options: ReadonlyArray<acp.SessionConfigOption> | null | undefined) =>
  options?.find(
    (o): o is acp.SessionConfigOption & { type: "select" } =>
      o.type === "select" && (o.category === "model" || o.id === "model"),
  );

const modelsOf = (option: acp.SessionConfigOption & { type: "select" }): Array<CommitModel> =>
  option.options
    .flatMap((o) => ("options" in o ? o.options : [o]))
    .map((o) => ({ value: o.value, name: o.name }));

const isCommitTarget = (arg: unknown): arg is CommitTarget =>
  Predicate.hasProperty(arg, "rootUri") &&
  arg.rootUri instanceof vscode.Uri &&
  Predicate.hasProperty(arg, "inputBox") &&
  Predicate.hasProperty(arg.inputBox, "value");

/** Generates a commit message for the pending changes with the selected ACP agent. */
export class CommitMessage extends Context.Service<CommitMessage, {
  /** `arg` is what the `scm/title` menu passes (the SourceControl); without one, picks a git repository. */
  generate(arg: unknown): Effect.Effect<void, CommitMessageError>;
  readonly cancel: Effect.Effect<void>;
  /** Models of the agent `agentId` (empty: the default agent), read from a throwaway session. */
  models(agentId: string): Effect.Effect<ReadonlyArray<CommitModel>, CommitMessageError>;
}>()("code-acp/CommitMessage") {
  static readonly layer = Layer.effect(
    CommitMessage,
    Effect.gen(function* () {
      const manager = yield* AgentManager;
      const output = yield* Output;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      let stop: Deferred.Deferred<void> | undefined;

      const fail = (message: string) => new CommitMessageError({ message });
      const git = (cwd: string, ...args: Array<string>) =>
        spawner.string(ChildProcess.make("git", args, { cwd })).pipe(Effect.orElseSucceed(() => ""));
      const setGenerating = (value: boolean) =>
        thenable(() => vscode.commands.executeCommand("setContext", GENERATING_KEY, value)).pipe(Effect.ignore);

      const resolveTarget = Effect.fn("CommitMessage.resolveTarget")(function* (arg: unknown) {
        if (isCommitTarget(arg)) {
          return arg;
        }
        const extension = vscode.extensions.getExtension<GitExtension>("vscode.git");
        const exports = extension
          ? yield* thenable(() => extension.activate()).pipe(Effect.orElseSucceed(() => undefined))
          : undefined;
        const repositories = exports?.getAPI(1).repositories ?? [];
        const active = vscode.window.activeTextEditor?.document.uri.fsPath;
        const target =
          repositories.find((repo) => active?.startsWith(repo.rootUri.fsPath)) ?? repositories[0];
        if (!target) {
          return yield* fail(t("commit.noRepository"));
        }
        return target;
      });

      /** Staged changes when there are any, otherwise the working tree (tracked diff + untracked file names). */
      const collectChanges = Effect.fn("CommitMessage.collectChanges")(function* (cwd: string) {
        const staged = yield* git(cwd, "diff", "--cached", "--no-color");
        const status = yield* git(cwd, "status", "--short", ...(staged.trim() ? [] : ["--untracked-files=all"]));
        const diff = staged.trim() ? staged : yield* git(cwd, "diff", "--no-color");
        if (!status.trim() && !diff.trim()) {
          return yield* fail(t("commit.noChanges"));
        }
        const log = yield* git(cwd, "log", "-n", "10", "--format=%s");
        const truncated = diff.length > MAX_DIFF_CHARS ? `${diff.slice(0, MAX_DIFF_CHARS)}\n[diff truncated]` : diff;
        return { staged: !!staged.trim(), status, diff: truncated, log };
      });

      /** The codeAcp.commitMessage.agent agent while installed, else the chat's default. */
      const commandFor = Effect.fn("CommitMessage.commandFor")(function* (agentId: string) {
        const agent = agentId ? yield* manager.get(agentId) : undefined;
        const command = agent ? manager.commandFor(agent) : yield* manager.selectedCommand;
        if (!command) {
          return yield* fail(t("chat.noAgent"));
        }
        return command;
      });

      /** Picks the model named by the setting (by value, else by name); keeps the default when there is none. */
      const selectModel = Effect.fn("CommitMessage.selectModel")(function* (
        agent: AcpAgent,
        session: acp.NewSessionResponse,
        model: string,
      ) {
        const option = modelOption(session.configOptions);
        const wanted = model.trim().toLowerCase();
        const match = option && modelsOf(option).find((m) => m.value.toLowerCase() === wanted || m.name.toLowerCase() === wanted);
        if (!option || !match) {
          output.appendLine(`[commit] ${t("commit.modelNotFound", model)}`);
          return;
        }
        if (option.currentValue !== match.value) {
          yield* agent.setConfigOption(session.sessionId, option.id, match.value);
        }
      });

      const buildPrompt = (changes: Effect.Success<ReturnType<typeof collectChanges>>, instructions: string): string =>
        [
          "Write a git commit message for the changes below.",
          "Reply with the commit message only: no preamble, no code fences, no explanation. Do not use any tools.",
          "Use a concise subject line (imperative mood, at most 72 characters), then a blank line and a short body only if it adds useful context.",
          changes.log.trim()
            ? `Follow the style and language of the recent commit subjects:\n${changes.log.trim()}`
            : "Write it in English.",
          "",
          changes.staged ? "Staged changes (git status --short):" : "Uncommitted changes (git status --short):",
          changes.status.trim(),
          "",
          "Diff:",
          changes.diff.trim() || "(no diff for tracked files; see the status above)",
          ...(instructions.trim()
            ? ["", "Additional instructions from the user; they take precedence over the rules above:", instructions.trim()]
            : []),
        ].join("\n");

      /** Drops code fences the agent may wrap the message in. */
      const clean = (text: string) =>
        text
          .trim()
          .replace(/^```[^\n]*\n([\s\S]*?)\n?```$/, "$1")
          .trim();

      const run = Effect.fn("CommitMessage.run")(
        function* (target: CommitTarget) {
          const settings = readSettings();
          const command = yield* commandFor(settings["commitMessage.agent"]);
          const cwd = target.rootUri.fsPath;
          const changes = yield* collectChanges(cwd);
          const previous = target.inputBox.value;
          let text = "";
          let sessionId: string | undefined;
          const agent = yield* spawnAgent(command, {
            onUpdate: (n) => {
              const update = n.update;
              if (n.sessionId === sessionId && update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
                text += update.content.text;
                target.inputBox.value = clean(text);
              }
            },
            // Nothing to approve here: the prompt asks for text only.
            requestPermission: () => Effect.succeed(CANCELLED),
          });
          const session = yield* agent.newSession(cwd);
          sessionId = session.sessionId;
          if (settings["commitMessage.model"].trim()) {
            yield* selectModel(agent, session, settings["commitMessage.model"]);
          }
          const prompt = buildPrompt(changes, settings["commitMessage.instructions"]);
          yield* agent.prompt(sessionId, [{ type: "text", text: prompt }]).pipe(
            Effect.onInterrupt(() => Effect.sync(() => (target.inputBox.value = previous))),
          );
          const message = clean(text);
          if (!message) {
            target.inputBox.value = previous;
            return yield* fail(t("commit.empty"));
          }
          target.inputBox.value = message;
        },
        Effect.scoped,
        Effect.provideService(Output, output),
        Effect.catchTags({
          AuthRequiredError: () => Effect.fail(fail(t("commit.needsLogin"))),
          AgentStartError: (err) => Effect.fail(fail(err.message)),
          AgentRequestError: (err) => Effect.fail(fail(t("commit.failed", err.message))),
        }),
      );

      const models = Effect.fn("CommitMessage.models")(
        function* (agentId: string) {
          const agent = yield* spawnAgent(yield* commandFor(agentId), {
            onUpdate: () => {},
            requestPermission: () => Effect.succeed(CANCELLED),
          });
          const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
          const session = yield* agent.newSession(cwd);
          const option = modelOption(session.configOptions);
          return option ? modelsOf(option) : [];
        },
        Effect.scoped,
        Effect.provideService(Output, output),
        Effect.catchTags({
          AuthRequiredError: () => Effect.fail(fail(t("commit.needsLogin"))),
          AgentStartError: (err) => Effect.fail(fail(err.message)),
          AgentRequestError: (err) => Effect.fail(fail(err.message)),
        }),
      );

      const generate = Effect.fn("CommitMessage.generate")(function* (arg: unknown) {
        if (stop) {
          return;
        }
        const target = yield* resolveTarget(arg);
        const current = yield* Deferred.make<void>();
        stop = current;
        yield* setGenerating(true);
        // The SCM view shows a progress bar until `done` completes.
        const done = yield* Deferred.make<void>();
        const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
        void vscode.window.withProgress(
          { location: vscode.ProgressLocation.SourceControl, title: t("commit.generating") },
          () => runPromise(Deferred.await(done)),
        );
        yield* Effect.raceFirst(run(target), Deferred.await(current)).pipe(
          Effect.tapError((err) => Effect.sync(() => output.appendLine(`[commit] ${messageOf(err)}`))),
          Effect.ensuring(
            Effect.suspend(() => {
              stop = undefined;
              return Deferred.succeed(done, undefined).pipe(Effect.andThen(setGenerating(false)));
            }),
          ),
        );
      });

      return CommitMessage.of({
        generate,
        models,
        cancel: Effect.suspend(() => (stop ? Deferred.succeed(stop, undefined).pipe(Effect.asVoid) : Effect.void)),
      });
    }),
  );
}
