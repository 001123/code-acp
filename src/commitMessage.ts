import type * as acp from "@agentclientprotocol/sdk";
import { Context, Deferred, Effect, Layer, Predicate, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as vscode from "vscode";
import { spawnAgent, type AcpAgent } from "./acpClient";
import { AgentManager } from "./agentManager";
import { t } from "./i18n";
import { ExtensionCtx, messageOf, Output, thenable } from "./runtime";
import { agentOptions, configureSession, type AgentOptions } from "./sessionOptions";
import { readSettings } from "./settings";
import { defaultCwd } from "./workspace";

/** A repository whose commit message box we fill: a `vscode.SourceControl` or a git extension repository. */
export interface CommitTarget {
  readonly rootUri: vscode.Uri;
  readonly inputBox: { value: string };
}

/** The part of the `vscode.git` extension API used here (see extensions/git/src/api/git.d.ts). */
interface GitRepository extends CommitTarget {
  readonly state: {
    readonly HEAD: { readonly name?: string; readonly upstream?: unknown } | undefined;
    readonly remotes: ReadonlyArray<{ readonly name: string }>;
    readonly indexChanges: ReadonlyArray<unknown>;
    readonly workingTreeChanges: ReadonlyArray<unknown>;
    readonly untrackedChanges?: ReadonlyArray<unknown>;
  };
  /** `all: true` stages every change, untracked files included, before committing. */
  commit(message: string, opts?: { all?: boolean }): Thenable<void>;
  push(remoteName?: string, branchName?: string, setUpstream?: boolean): Thenable<void>;
}
interface GitApi {
  readonly repositories: ReadonlyArray<GitRepository>;
  getRepository(uri: vscode.Uri): GitRepository | null;
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
/**
 * Generated lockfiles, left out of the diff: they can be megabytes and say nothing a message needs. They
 * still show in `git status`.
 */
const DIFF_EXCLUDES = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
  "composer.lock",
  "Gemfile.lock",
  "go.sum",
].map((name) => `:(exclude,glob)**/${name}`);
const CANCELLED: acp.RequestPermissionResponse = { outcome: { outcome: "cancelled" } };

const isCommitTarget = (arg: unknown): arg is CommitTarget =>
  Predicate.hasProperty(arg, "rootUri") &&
  arg.rootUri instanceof vscode.Uri &&
  Predicate.hasProperty(arg, "inputBox") &&
  Predicate.hasProperty(arg.inputBox, "value");

/** Generates a commit message for the pending changes with the selected ACP agent. */
export class CommitMessage extends Context.Service<CommitMessage, {
  /** `arg` is what the `scm/title` menu passes (the SourceControl); without one, picks a git repository. */
  generate(arg: unknown): Effect.Effect<void, CommitMessageError>;
  /** Commits with the message in the box (generating one when it is empty), then pushes. */
  commitAndPush(arg: unknown): Effect.Effect<void, CommitMessageError>;
  readonly cancel: Effect.Effect<void>;
  /**
   * What the agent `agentId` (empty: the default agent) offers to pick, read from a throwaway session; the efforts
   * are those of `model` (empty: the agent's default one).
   */
  options(agentId: string, model: string): Effect.Effect<AgentOptions, CommitMessageError>;
}>()("code-acp/CommitMessage") {
  static readonly layer = Layer.effect(
    CommitMessage,
    Effect.gen(function* () {
      const manager = yield* AgentManager;
      const output = yield* Output;
      const context = yield* ExtensionCtx;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      let stop: Deferred.Deferred<void> | undefined;
      let pushing = false;

      const fail = (message: string) => new CommitMessageError({ message });
      const git = (cwd: string, ...args: Array<string>) =>
        spawner.string(ChildProcess.make("git", args, { cwd })).pipe(Effect.orElseSucceed(() => ""));
      /** At most about `max` characters of git's output; git is stopped once that much has come in. */
      const gitHead = (cwd: string, max: number, ...args: Array<string>) =>
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(ChildProcess.make("git", args, { cwd }));
          let text = "";
          yield* handle.stdout.pipe(
            Stream.decodeText(),
            Stream.takeUntil((chunk) => (text += chunk).length >= max),
            Stream.runDrain,
          );
          return text;
        }).pipe(Effect.scoped, Effect.orElseSucceed(() => ""));
      const diff = (cwd: string, ...args: Array<string>) =>
        gitHead(cwd, MAX_DIFF_CHARS + 1, "diff", "--no-color", ...args, "--", ".", ...DIFF_EXCLUDES);
      const setGenerating = (value: boolean) =>
        thenable(() => vscode.commands.executeCommand("setContext", GENERATING_KEY, value)).pipe(Effect.ignore);

      const gitApi = Effect.gen(function* () {
        const extension = vscode.extensions.getExtension<GitExtension>("vscode.git");
        const exports = extension
          ? yield* thenable(() => extension.activate()).pipe(Effect.orElseSucceed(() => undefined))
          : undefined;
        return exports?.getAPI(1);
      });

      const resolveTarget = Effect.fn("CommitMessage.resolveTarget")(function* (arg: unknown) {
        if (isCommitTarget(arg)) {
          return arg;
        }
        const repositories = (yield* gitApi)?.repositories ?? [];
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
        // By name: a staged lockfile alone leaves the diff empty, but it is still what gets committed.
        const staged = !!(yield* gitHead(cwd, 1, "diff", "--cached", "--name-only")).trim();
        const status = yield* git(cwd, "status", "--short", ...(staged ? [] : ["--untracked-files=all"]));
        const changes = yield* diff(cwd, ...(staged ? ["--cached"] : []));
        if (!status.trim() && !changes.trim()) {
          return yield* fail(t("commit.noChanges"));
        }
        const log = yield* git(cwd, "log", "-n", "10", "--format=%s");
        const truncated = changes.length > MAX_DIFF_CHARS ? `${changes.slice(0, MAX_DIFF_CHARS)}\n[diff truncated]` : changes;
        return { staged, status, diff: truncated, log };
      });

      /** The codeAcp.commitMessage.agent agent while it exists, else the chat's default. */
      const commandFor = Effect.fn("CommitMessage.commandFor")(function* (agentId: string) {
        const command = (agentId ? yield* manager.command(agentId) : undefined) ?? (yield* manager.selectedCommand);
        if (!command) {
          return yield* fail(t("chat.noAgent"));
        }
        return command;
      });

      const buildPrompt = (changes: Effect.Success<ReturnType<typeof collectChanges>>, instructions: string): string =>
        [
          "Write a git commit message for the changes below.",
          "Reply with the commit message only: no preamble, no code fences, no explanation. Do not use any tools.",
          "Write a single subject line only (imperative mood, at most 72 characters), with no body.",
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
          yield* configureSession(
            agent,
            session,
            { model: settings["commitMessage.model"], effort: settings["commitMessage.effort"], fastMode: settings["commitMessage.fastMode"] },
            (what, value) => output.appendLine(`[commit] ${t(what === "model" ? "commit.modelNotFound" : "commit.effortNotFound", value)}`),
          );
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
          return message;
        },
        Effect.scoped,
        Effect.provideService(Output, output),
        Effect.provideService(ExtensionCtx, context),
        Effect.catchTags({
          AuthRequiredError: () => Effect.fail(fail(t("commit.needsLogin"))),
          AgentStartError: (err) => Effect.fail(fail(err.message)),
          AgentRequestError: (err) => Effect.fail(fail(t("commit.failed", err.message))),
        }),
      );

      const options = Effect.fn("CommitMessage.options")(
        function* (agentId: string, model: string) {
          const agent = yield* spawnAgent(yield* commandFor(agentId), {
            onUpdate: () => {},
            requestPermission: () => Effect.succeed(CANCELLED),
          });
          const session = yield* agent.newSession(defaultCwd());
          return agentOptions(yield* configureSession(agent, session, { model, effort: "", fastMode: "default" }));
        },
        Effect.scoped,
        Effect.provideService(Output, output),
        Effect.provideService(ExtensionCtx, context),
        Effect.catchTags({
          AuthRequiredError: () => Effect.fail(fail(t("commit.needsLogin"))),
          AgentStartError: (err) => Effect.fail(fail(err.message)),
          AgentRequestError: (err) => Effect.fail(fail(err.message)),
        }),
      );

      /** Generates into the target's box with the stop button shown; `undefined` when the user stops it. */
      const generateInto = Effect.fn("CommitMessage.generateInto")(function* (target: CommitTarget) {
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
        return yield* Effect.raceFirst(run(target), Deferred.await(current).pipe(Effect.as(undefined))).pipe(
          Effect.tapError((err) => Effect.sync(() => output.appendLine(`[commit] ${messageOf(err)}`))),
          Effect.ensuring(
            Effect.suspend(() => {
              stop = undefined;
              return Deferred.succeed(done, undefined).pipe(Effect.andThen(setGenerating(false)));
            }),
          ),
        );
      });

      const generate = Effect.fn("CommitMessage.generate")(function* (arg: unknown) {
        if (stop || pushing) {
          return;
        }
        yield* generateInto(yield* resolveTarget(arg));
      });

      /** Pushes to the upstream, or publishes the branch to `origin` (else the first remote). */
      const pushFor = Effect.fn("CommitMessage.pushFor")(function* (repo: GitRepository) {
        const head = repo.state.HEAD;
        if (head?.upstream) {
          return () => repo.push();
        }
        if (!head?.name) {
          return yield* fail(t("commit.detachedHead"));
        }
        const remote = repo.state.remotes.find((r) => r.name === "origin") ?? repo.state.remotes[0];
        if (!remote) {
          return yield* fail(t("commit.noRemote"));
        }
        const branch = head.name;
        return () => repo.push(remote.name, branch, true);
      });

      const withProgress = (title: string, task: () => Thenable<void>) =>
        thenable(() => vscode.window.withProgress({ location: vscode.ProgressLocation.SourceControl, title }, task));

      const commitAndPush = Effect.fn("CommitMessage.commitAndPush")(function* (arg: unknown) {
        if (stop || pushing) {
          return;
        }
        const target = yield* resolveTarget(arg);
        const repo = (yield* gitApi)?.getRepository(target.rootUri);
        if (!repo) {
          return yield* fail(t("commit.noRepository"));
        }
        const { indexChanges, workingTreeChanges, untrackedChanges = [] } = repo.state;
        const staged = indexChanges.length > 0;
        if (!staged && !workingTreeChanges.length && !untrackedChanges.length) {
          return yield* fail(t("commit.noChanges"));
        }
        // Checked before committing, so a branch that cannot be pushed is left untouched.
        const push = yield* pushFor(repo);
        const message = target.inputBox.value.trim() || (yield* generateInto(target));
        if (!message) {
          return;
        }
        pushing = true;
        yield* Effect.gen(function* () {
          // Nothing staged: commit every change, like the generated message describes.
          yield* withProgress(t("commit.committing"), () => repo.commit(message, { all: !staged })).pipe(
            Effect.mapError((err) => fail(t("commit.commitFailed", err.message))),
          );
          if (target.inputBox.value.trim() === message) {
            target.inputBox.value = "";
          }
          yield* withProgress(t("commit.pushing"), push).pipe(
            Effect.mapError((err) => fail(t("commit.pushFailed", err.message))),
          );
        }).pipe(Effect.ensuring(Effect.sync(() => (pushing = false))));
      });

      return CommitMessage.of({
        generate,
        commitAndPush,
        options,
        cancel: Effect.suspend(() => (stop ? Deferred.succeed(stop, undefined).pipe(Effect.asVoid) : Effect.void)),
      });
    }),
  );
}
