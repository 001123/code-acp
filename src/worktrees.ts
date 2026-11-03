import { Context, Duration, Effect, FileSystem, Layer, Option, Predicate, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { cp } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { t } from "./i18n";
import { messageOf } from "./runtime";
import { projectSetupCommand, readSettings } from "./settings";

/** Branches of the worktrees the extension creates. */
const BRANCH_PREFIX = "code-acp/";
/** A branch still on the random name it was created with. */
const UNNAMED_BRANCH = new RegExp(`^${BRANCH_PREFIX}[0-9a-f]{6}$`);
/** Under the prefix, the branches of the attempts of a comparison. No other branch may take this name: git couldn't have both. */
const COMPARE_DIR = "compare";
const MAX_SLUG_WORDS = 5;
const MAX_SLUG_LENGTH = 40;
/** Of a comparison's branch: the prompt and the attempt each get this much, to keep it readable. */
const MAX_ATTEMPT_SLUG_LENGTH = 24;

/** Where the extension's worktrees live, outside the repository so that they never show up in it. */
const MANAGED_DIR = path.join(".code-acp", "worktrees");
/** How long a worktree's setup command may run; a dev server would otherwise keep the tab waiting for good. */
const SETUP_TIMEOUT_MINUTES = 10;
/** How much of a failed setup command's output its error shows, from the end. */
const SETUP_OUTPUT_TAIL = 2000;
/** How long a push or a call to GitHub may run; a remote that doesn't answer would otherwise keep the user waiting for good. */
const REMOTE_TIMEOUT_MINUTES = 10;

/** The git worktree a tab runs in. */
export const TabWorktree = Schema.Struct({
  /** The worktree's top folder. */
  root: Schema.String,
  /** Undefined when its HEAD is detached. */
  branch: Schema.optional(Schema.String),
  /** The workspace folder the tab goes back to when it leaves the worktree; changes are applied there. */
  base: Schema.String,
});
export type TabWorktree = typeof TabWorktree.Type;

/** The setup command a project asks for; it only runs once the user allows it. */
export interface ProjectCommand {
  readonly command: string;
  /** What the user allows: changes with the command, its repository and the files it names. */
  readonly fingerprint: string;
}

/** Whether the user allows a project's setup command. */
export type ApproveCommand = (request: ProjectCommand) => Effect.Effect<boolean>;

/** A worktree, and the folder in it that matches its base folder: a session's cwd. */
export interface PlacedWorktree {
  readonly worktree: TabWorktree;
  readonly cwd: string;
}

/** What a worktree holds that its base folder doesn't. */
export interface WorktreeStatus {
  /** Changed and untracked files, not committed. */
  readonly changed: number;
  /** Commits since it forked off the base folder's HEAD. */
  readonly commits: number;
}

/** A file a worktree changed; binary files have no line counts. */
export interface WorktreeFileDiff {
  /** From the top of the worktree. */
  readonly path: string;
  readonly added?: number;
  readonly removed?: number;
}

export interface AppliedWorktree {
  readonly applied: boolean;
  /** Files left with conflict markers in the base folder. */
  readonly conflicts: ReadonlyArray<string>;
}

export interface MergedWorktree {
  /** Files left with conflict markers in the base folder, whose merge is still going on. */
  readonly conflicts: ReadonlyArray<string>;
}

/** Where a pull request of a worktree's branch goes. */
export interface PrTarget {
  readonly remote: string;
  /** The branch it would merge into; undefined leaves that to the repository's default branch. */
  readonly base?: string;
  /** The pull request that is already open for the branch. */
  readonly existing?: string;
}

/** The title and description of a pull request. */
export interface PrText {
  readonly title: string;
  readonly body: string;
}

/** What a worktree's branch holds, for describing it. */
export interface PrSummary {
  /** The commit it forked off. */
  readonly fork: string;
  /** Subjects of its commits, oldest first. */
  readonly subjects: ReadonlyArray<string>;
  /** `git diff --stat` against the fork. */
  readonly stat: string;
}

const decodePrList = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.Struct({ url: Schema.String }))));

export class WorktreeError extends Schema.TaggedError<WorktreeError>()("WorktreeError", {
  message: Schema.String,
}) {}

/** Whether the extension created the worktree at `root`, so that it may delete it; others are the user's. */
export function isManaged(root: string): boolean {
  return root.includes(`${path.sep}${MANAGED_DIR}${path.sep}`);
}

/** Where `file` is in a worktree whose `cwd` matches `base`; undefined when it is outside `base`. */
export function intoWorktree(file: string, base: string, cwd: string): string | undefined {
  const relative = path.relative(base, file);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ? undefined : path.join(cwd, relative);
}

/** The worktrees in the output of `git worktree list --porcelain`, without those whose folder is gone. */
export function parseWorktreeList(output: string): ReadonlyArray<{ readonly root: string; readonly branch?: string }> {
  return output.split(/\n\n+/).flatMap((block) => {
    const lines = block.split("\n");
    const root = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
    if (!root || lines.some((line) => line === "bare" || line.startsWith("prunable"))) {
      return [];
    }
    const branch = lines.find((line) => line.startsWith("branch refs/heads/"))?.slice("branch refs/heads/".length);
    return [branch === undefined ? { root } : { root, branch }];
  });
}

/** The entries of a `git ls-files --directory` listing without those inside a directory it lists too, and without its slashes. */
export function outermostEntries(entries: ReadonlyArray<string>): ReadonlyArray<string> {
  const directories = entries.filter((entry) => entry.endsWith("/"));
  return entries
    .filter((entry) => !directories.some((directory) => entry !== directory && entry.startsWith(directory)))
    .map((entry) => entry.replace(/\/$/, ""));
}

/** The start of the first line of `text` as a part of a branch name, without accents; undefined when nothing in it can be one. */
export function branchSlug(text: string, maxLength = MAX_SLUG_LENGTH): string | undefined {
  const words = (text.trim().split("\n")[0] ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return words.slice(0, MAX_SLUG_WORDS).join("-").slice(0, maxLength).replace(/-$/, "") || undefined;
}

/** The name, under the prefix, for the branch of an attempt at `prompt` in a comparison. */
export function attemptBranchName(prompt: string, attempt: string): string {
  const parts = [branchSlug(prompt, MAX_ATTEMPT_SLUG_LENGTH), branchSlug(attempt, MAX_ATTEMPT_SLUG_LENGTH)].filter(Predicate.isString);
  return `${COMPARE_DIR}/${parts.join("-") || "attempt"}`;
}

/** `name`, with a number when it is in `taken` or reserved. */
export function freeBranchName(name: string, taken: ReadonlySet<string>): string {
  const isFree = (candidate: string) => candidate !== COMPARE_DIR && !taken.has(candidate);
  let candidate = name;
  for (let n = 2; !isFree(candidate); n++) {
    candidate = `${name}-${n}`;
  }
  return candidate;
}

/** The files in the output of `git diff --numstat -z --no-renames`. */
export const parseNumstat = (out: string): ReadonlyArray<WorktreeFileDiff> =>
  out.split("\0").flatMap((entry) => {
    const [added, removed, ...name] = entry.split("\t");
    if (added === undefined || removed === undefined || name.length === 0) {
      return [];
    }
    const counts = added === "-" ? {} : { added: Number(added), removed: Number(removed) };
    return [{ path: name.join("\t"), ...counts }];
  });

/** The title and description in an agent's reply: its first line, then the rest; undefined when it has no text. */
export function parsePrText(reply: string): PrText | undefined {
  const text = reply
    .trim()
    .replace(/^```[^\n]*\n([\s\S]*?)\n?```$/, "$1")
    .trim();
  const [first = "", ...rest] = text.split("\n");
  const title = first.replace(/^#+\s*/, "").trim();
  return title === "" ? undefined : { title, body: rest.join("\n").trim() };
}

/** A title and description from what git knows, when no agent wrote them. */
export function fallbackPrText({ subjects, stat }: PrSummary, title: string): PrText {
  const list = subjects.map((subject) => `- ${subject}`).join("\n");
  const files = stat.trim() === "" ? "" : `\`\`\`\n${stat.trimEnd()}\n\`\`\``;
  return { title: subjects.length === 1 ? subjects[0]! : title, body: [list, files].filter(Boolean).join("\n\n") };
}

/** The git worktrees chat tabs run in. Listings come from git, so worktrees made outside the extension show up too. */
export class Worktrees extends Context.Service<Worktrees, {
  /** Whether `folder` is in a git work tree. */
  isRepo(folder: string): Effect.Effect<boolean>;
  /** The branch checked out in `folder`, else its short commit when HEAD is detached; undefined outside git. */
  branchOf(folder: string): Effect.Effect<string | undefined>;
  /**
   * A new worktree from the HEAD of `folder`, on a new branch called `name` under the prefix, or a random name without
   * one; none when `folder` isn't in a git work tree.
   */
  create(folder: string, name?: string): Effect.Effect<Option.Option<PlacedWorktree>, WorktreeError>;
  /**
   * The worktree with its branch named after `text`. Only a branch the extension created and that still has its random
   * name and no commits changes; the worktree's folder stays, as sessions run in it.
   */
  nameAfter(worktree: TabWorktree, text: string): Effect.Effect<TabWorktree, WorktreeError>;
  /**
   * Readies a new worktree as the settings say: copies ignored files from its base checkout, then runs a setup
   * command at its top: the project's if `approve` allows it (without `approve` it doesn't run), else the user's.
   * One failure doesn't stop the rest; it fails in the end with all of them.
   */
  setup(worktree: TabWorktree, approve?: ApproveCommand): Effect.Effect<void, WorktreeError>;
  /** The other worktrees of the repository of `folder`, which becomes their base. */
  list(folder: string): Effect.Effect<ReadonlyArray<PlacedWorktree>, WorktreeError>;
  /** The worktree of one of `folders`' repositories holding `cwd`. */
  locate(folders: ReadonlyArray<string>, cwd: string): Effect.Effect<TabWorktree | undefined>;
  exists(folder: string): Effect.Effect<boolean>;
  /** Puts a missing worktree the extension created back on its branch; false when it can't be. */
  restore(worktree: TabWorktree): Effect.Effect<boolean>;
  status(worktree: TabWorktree): Effect.Effect<WorktreeStatus, WorktreeError>;
  /** The files the worktree holds differently from the commit it forked off, committed or not. */
  diff(worktree: TabWorktree): Effect.Effect<ReadonlyArray<WorktreeFileDiff>, WorktreeError>;
  /** What `file` (from the top of the worktree) held in the commit the worktree forked off; null when it didn't exist. */
  original(worktree: TabWorktree, file: string): Effect.Effect<string | null, WorktreeError>;
  /**
   * Brings what the worktree holds, committed or not, into its base folder as staged changes. The worktree stays
   * as it is. Nothing is changed when the base folder's own changes are in the way.
   */
  apply(worktree: TabWorktree): Effect.Effect<AppliedWorktree, WorktreeError>;
  /** Commits everything the worktree holds on its branch, untracked files included. */
  commit(worktree: TabWorktree, message: string): Effect.Effect<void, WorktreeError>;
  /** Whether the base folder has uncommitted changes to tracked files, which a merge shouldn't run into. */
  isBaseDirty(worktree: TabWorktree): Effect.Effect<boolean, WorktreeError>;
  /**
   * Merges the worktree's branch into what its base folder has checked out, commits and all. It fails when the base
   * folder isn't clean; with conflicts, the merge stays open there for the user to finish or abort.
   */
  merge(worktree: TabWorktree): Effect.Effect<MergedWorktree, WorktreeError>;
  /** Gives up the merge going on in the worktree's base folder. */
  abortMerge(worktree: TabWorktree): Effect.Effect<void, WorktreeError>;
  /** Where a pull request of the worktree's branch goes; fails without a branch, a remote or a working `gh`. */
  prTarget(worktree: TabWorktree): Effect.Effect<PrTarget, WorktreeError>;
  /** What the worktree's branch holds. */
  prSummary(worktree: TabWorktree): Effect.Effect<PrSummary, WorktreeError>;
  /** Pushes the worktree's branch to `remote`, and tracks it there. */
  push(worktree: TabWorktree, remote: string): Effect.Effect<void, WorktreeError>;
  /** Opens a pull request of the worktree's pushed branch; its URL. */
  createPr(worktree: TabWorktree, text: PrText, base?: string): Effect.Effect<string, WorktreeError>;
  /** Deletes a worktree the extension created, and its branch; others are left alone. */
  remove(worktree: TabWorktree): Effect.Effect<void, WorktreeError>;
}>()("code-acp/Worktrees") {
  static readonly layer = Layer.effect(
    Worktrees,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fs = yield* FileSystem.FileSystem;

      const failed = (command: string, reason: unknown) => new WorktreeError({ message: t("worktree.gitFailed", command, reason) });

      /** Runs git in `cwd`, whatever its exit code. */
      const exec = Effect.fn("Worktrees.exec")(
        function* (cwd: string, args: ReadonlyArray<string>, env?: Record<string, string>, input?: string) {
          const stdin = input === undefined ? undefined : Stream.make(new TextEncoder().encode(input));
          const handle = yield* spawner.spawn(ChildProcess.make("git", args, { cwd, env, extendEnv: true, stdin }));
          const [out, err, code] = yield* Effect.all(
            [Stream.mkString(Stream.decodeText(handle.stdout)), Stream.mkString(Stream.decodeText(handle.stderr)), handle.exitCode],
            { concurrency: "unbounded" },
          );
          return { out, err: err.trim(), code };
        },
        Effect.scoped,
        Effect.mapError((err) => failed("git", messageOf(err))),
      );

      /** Runs git in `cwd`; fails unless it exits with code 0. */
      const git = Effect.fnUntraced(function* (cwd: string, args: ReadonlyArray<string>, env?: Record<string, string>) {
        const { out, err, code } = yield* exec(cwd, args, env);
        if (code !== 0) {
          return yield* failed(args[0] ?? "git", err || code);
        }
        return out;
      });

      /** Runs `gh` in `cwd`, without ever waiting for an answer from the user; fails unless it exits with code 0. */
      const gh = Effect.fn("Worktrees.gh")(
        function* (cwd: string, args: ReadonlyArray<string>, input?: string) {
          const stdin = input === undefined ? undefined : Stream.make(new TextEncoder().encode(input));
          const env = { GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" };
          const handle = yield* spawner.spawn(ChildProcess.make("gh", args, { cwd, env, extendEnv: true, stdin }));
          const [out, err, code] = yield* Effect.all(
            [Stream.mkString(Stream.decodeText(handle.stdout)), Stream.mkString(Stream.decodeText(handle.stderr)), handle.exitCode],
            { concurrency: "unbounded" },
          );
          if (code !== 0) {
            return yield* new WorktreeError({ message: t("worktree.ghFailed", err.trim() || code) });
          }
          return out;
        },
        Effect.scoped,
        Effect.catchTag("PlatformError", () => Effect.fail(new WorktreeError({ message: t("worktree.ghMissing") }))),
        Effect.timeoutOrElse({
          duration: Duration.minutes(REMOTE_TIMEOUT_MINUTES),
          orElse: () => Effect.fail(new WorktreeError({ message: t("worktree.remoteTimedOut", REMOTE_TIMEOUT_MINUTES) })),
        }),
      );

      const exists = (folder: string) => fs.exists(folder).pipe(Effect.orElseSucceed(() => false));

      /** The top of the work tree holding `folder`, and `folder` relative to it. */
      const repoOf = (folder: string) =>
        git(folder, ["rev-parse", "--show-toplevel", "--show-prefix"]).pipe(
          Effect.map((out) => {
            const [top = "", prefix = ""] = out.split("\n");
            return top ? Option.some({ top, prefix }) : Option.none();
          }),
          Effect.orElseSucceed(() => Option.none<{ top: string; prefix: string }>()),
        );

      const branchOf = (folder: string) =>
        git(folder, ["symbolic-ref", "--short", "-q", "HEAD"]).pipe(
          Effect.catch(() => git(folder, ["rev-parse", "--short", "HEAD"])),
          Effect.map((out): string | undefined => out.trim() || undefined),
          Effect.orElseSucceed(() => undefined),
        );

      /** The branch under the prefix to use for `name`, given the ones that exist. */
      const freeBranch = Effect.fnUntraced(function* (folder: string, name: string) {
        const refs = yield* git(folder, ["for-each-ref", "--format=%(refname)", `refs/heads/${BRANCH_PREFIX}`]);
        const taken = refs.split("\n").filter(Boolean).map((ref) => ref.slice(`refs/heads/${BRANCH_PREFIX}`.length));
        return `${BRANCH_PREFIX}${freeBranchName(name, new Set(taken))}`;
      });

      const create = Effect.fn("Worktrees.create")(function* (folder: string, name?: string) {
        const repo = yield* repoOf(folder);
        if (Option.isNone(repo)) {
          return Option.none<PlacedWorktree>();
        }
        const { top, prefix } = repo.value;
        const slug = randomBytes(3).toString("hex");
        const repoDir = `${path.basename(top)}-${createHash("sha256").update(top).digest("hex").slice(0, 8)}`;
        const dir = path.join(os.homedir(), MANAGED_DIR, repoDir, slug);
        const branch = name === undefined ? `${BRANCH_PREFIX}${slug}` : yield* freeBranch(folder, name);
        yield* fs.makeDirectory(path.dirname(dir), { recursive: true }).pipe(Effect.mapError((err) => failed("worktree", err.message)));
        yield* git(folder, ["worktree", "add", "--quiet", "-b", branch, dir, "HEAD"]);
        // As git reports it, with symbolic links resolved, to match its listings.
        const root = (yield* git(dir, ["rev-parse", "--show-toplevel"])).trim();
        const cwd = path.resolve(root, prefix);
        // A folder with nothing committed in it isn't in the new worktree.
        yield* fs.makeDirectory(cwd, { recursive: true }).pipe(Effect.mapError((err) => failed("worktree", err.message)));
        return Option.some<PlacedWorktree>({ worktree: { root, branch, base: folder }, cwd });
      });

      /** Copies the ignored files of the base checkout that `patterns` name; returns what went wrong. */
      const copyIgnored = Effect.fnUntraced(function* (worktree: TabWorktree, patterns: ReadonlyArray<string>) {
        const repo = yield* repoOf(worktree.base);
        if (Option.isNone(repo)) {
          return [];
        }
        const { top } = repo.value;
        const named = yield* git(top, ["ls-files", "-z", "--others", "--ignored", "--directory", ...patterns.map((pattern) => `--exclude=${pattern}`)]);
        // By the worktree's own rules: a file it doesn't ignore would be staged when its changes are applied.
        const { out, err, code } = yield* exec(worktree.root, ["check-ignore", "-z", "--stdin"], undefined, named);
        if (code > 1) {
          return yield* failed("check-ignore", err || code);
        }
        const failures = yield* Effect.forEach(outermostEntries(out.split("\0").filter(Boolean)), (entry) =>
          Effect.tryPromise(() =>
            cp(path.join(top, entry), path.join(worktree.root, entry), {
              recursive: true,
              force: false,
              // Relative links, as in node_modules, keep pointing inside the copy.
              verbatimSymlinks: true,
              // A clone where the filesystem has them, so that a large node_modules takes no space.
              mode: fsConstants.COPYFILE_FICLONE,
            }),
          ).pipe(
            Effect.as(undefined),
            Effect.catch((err) => Effect.succeed(t("worktree.copyFailed", entry, messageOf(err)))),
          ),
        );
        return failures.filter((failure) => failure !== undefined);
      });

      /** Runs the setup command at the top of the worktree; its output only matters when it fails. */
      const runSetupCommand = Effect.fn("Worktrees.runSetupCommand")(
        function* (root: string, command: string) {
          const handle = yield* spawner.spawn(
            ChildProcess.make(command, [], { cwd: root, shell: true, stdin: "ignore", forceKillAfter: "5 seconds" }),
          );
          let tail = "";
          // Not waited for: a process the command leaves behind may hold on to the output.
          yield* handle.all.pipe(
            Stream.decodeText,
            Stream.runForEach((text) => Effect.sync(() => (tail = (tail + text).slice(-SETUP_OUTPUT_TAIL)))),
            Effect.forkScoped,
          );
          const code = yield* handle.exitCode;
          if (code !== 0) {
            return yield* new WorktreeError({ message: t("worktree.setupFailed", code, tail.trim()) });
          }
        },
        Effect.scoped,
        Effect.catchTag("PlatformError", (err) => Effect.fail(new WorktreeError({ message: t("worktree.setupFailed", "-", err.message) }))),
        Effect.timeoutOrElse({
          duration: Duration.minutes(SETUP_TIMEOUT_MINUTES),
          orElse: () => Effect.fail(new WorktreeError({ message: t("worktree.setupTimedOut", SETUP_TIMEOUT_MINUTES) })),
        }),
      );

      /**
       * Identifies a project's command in its repository. Files it names count, as a pull can change what a script
       * does without changing the command; what it runs by other means, such as npm's scripts, doesn't.
       */
      const fingerprintOf = Effect.fnUntraced(function* (worktree: TabWorktree, command: string) {
        const repo = yield* repoOf(worktree.base);
        const top = Option.match(repo, { onNone: () => worktree.base, onSome: ({ top }) => top });
        const hash = createHash("sha256").update(JSON.stringify([top, command]));
        for (const word of new Set(command.split(/[\s;&|()<>"'=]+/).filter(Boolean))) {
          const file = intoWorktree(path.resolve(worktree.root, word), worktree.root, worktree.root);
          // Most words are no file, or a folder.
          const content = file === undefined ? Option.none() : yield* fs.readFile(file).pipe(Effect.option);
          if (Option.isSome(content)) {
            hash.update(JSON.stringify(word)).update(content.value);
          }
        }
        return hash.digest("hex");
      });

      const setup = Effect.fn("Worktrees.setup")(function* (worktree: TabWorktree, approve?: ApproveCommand) {
        const { worktreeCopyFiles: patterns, worktreeSetupCommand: userCommand } = readSettings();
        const failures = patterns.length === 0
          ? []
          : [...yield* copyIgnored(worktree, patterns).pipe(Effect.catch((err) => Effect.succeed([err.message])))];
        // After the copy: a script the project's command names may be among the copied files.
        const project = projectSetupCommand(worktree.base);
        const allowed = project !== "" && approve !== undefined
          && (yield* approve({ command: project, fingerprint: yield* fingerprintOf(worktree, project) }));
        const command = allowed ? project : userCommand;
        if (command !== "") {
          yield* runSetupCommand(worktree.root, command).pipe(
            Effect.catch((err) => Effect.sync(() => failures.push(err.message))),
          );
        }
        if (failures.length > 0) {
          return yield* new WorktreeError({ message: failures.join("\n") });
        }
      });

      const list = Effect.fn("Worktrees.list")(function* (folder: string) {
        const repo = yield* repoOf(folder);
        if (Option.isNone(repo)) {
          return [];
        }
        const { top, prefix } = repo.value;
        return parseWorktreeList(yield* git(folder, ["worktree", "list", "--porcelain"]))
          .filter(({ root }) => root !== top)
          .map(({ root, branch }): PlacedWorktree => ({
            worktree: branch === undefined ? { root, base: folder } : { root, branch, base: folder },
            cwd: path.resolve(root, prefix),
          }));
      });

      const locate = Effect.fn("Worktrees.locate")(function* (folders: ReadonlyArray<string>, cwd: string) {
        for (const folder of folders) {
          const listed = yield* list(folder).pipe(Effect.orElseSucceed((): ReadonlyArray<PlacedWorktree> => []));
          const found = listed.find(({ worktree }) => intoWorktree(cwd, worktree.root, worktree.root) !== undefined);
          if (found) {
            return found.worktree;
          }
        }
        return undefined;
      });

      const restore = Effect.fn("Worktrees.restore")(function* (worktree: TabWorktree) {
        if (yield* exists(worktree.root)) {
          return true;
        }
        if (!isManaged(worktree.root) || worktree.branch === undefined) {
          return false;
        }
        yield* git(worktree.base, ["worktree", "prune"]);
        yield* fs.makeDirectory(path.dirname(worktree.root), { recursive: true }).pipe(Effect.mapError((err) => failed("worktree", err.message)));
        yield* git(worktree.base, ["worktree", "add", "--quiet", worktree.root, worktree.branch]);
        return true;
      }, Effect.orElseSucceed(() => false));

      /** The commit the worktree forked off the base folder's history. */
      const forkPoint = Effect.fnUntraced(function* (worktree: TabWorktree) {
        const baseHead = (yield* git(worktree.base, ["rev-parse", "HEAD"])).trim();
        return (yield* git(worktree.root, ["merge-base", "HEAD", baseHead])).trim();
      });

      const commitsSinceFork = Effect.fnUntraced(function* (worktree: TabWorktree) {
        const fork = yield* forkPoint(worktree);
        return Number((yield* git(worktree.root, ["rev-list", "--count", `${fork}..HEAD`])).trim());
      });

      const status = Effect.fn("Worktrees.status")(function* (worktree: TabWorktree) {
        const changed = (yield* git(worktree.root, ["status", "--porcelain"])).split("\n").filter(Boolean).length;
        return { changed, commits: yield* commitsSinceFork(worktree) };
      });

      const nameAfter = Effect.fn("Worktrees.nameAfter")(function* (worktree: TabWorktree, text: string) {
        const { branch } = worktree;
        const slug = branchSlug(text);
        if (slug === undefined || branch === undefined || !UNNAMED_BRANCH.test(branch) || !isManaged(worktree.root) || (yield* commitsSinceFork(worktree)) > 0) {
          return worktree;
        }
        const named = yield* freeBranch(worktree.base, slug);
        yield* git(worktree.base, ["branch", "-m", branch, named]);
        return { ...worktree, branch: named };
      });

      /** The tree of everything the worktree holds, on a scratch index so that what it has staged stays as it is. */
      const snapshot = Effect.fnUntraced(function* (worktree: TabWorktree) {
        const scratch = yield* fs.makeTempDirectoryScoped().pipe(Effect.mapError((err) => failed("snapshot", err.message)));
        const env = { GIT_INDEX_FILE: path.join(scratch, "index") };
        yield* git(worktree.root, ["read-tree", "HEAD"], env);
        yield* git(worktree.root, ["add", "--all"], env);
        return { scratch, tree: (yield* git(worktree.root, ["write-tree"], env)).trim() };
      });

      const diff = Effect.fn("Worktrees.diff")(
        function* (worktree: TabWorktree) {
          const { tree } = yield* snapshot(worktree);
          const fork = yield* forkPoint(worktree);
          const out = yield* git(worktree.root, ["diff", "--numstat", "-z", "--no-renames", "--no-color", "--no-ext-diff", fork, tree]);
          return parseNumstat(out);
        },
        Effect.scoped,
      );

      const original = Effect.fn("Worktrees.original")(function* (worktree: TabWorktree, file: string) {
        const fork = yield* forkPoint(worktree);
        const { out, code } = yield* exec(worktree.root, ["show", `${fork}:${file}`]);
        return code === 0 ? out : null;
      });

      const apply = Effect.fn("Worktrees.apply")(
        function* (worktree: TabWorktree) {
          const repo = yield* repoOf(worktree.base);
          if (Option.isNone(repo)) {
            return yield* failed("apply", worktree.base);
          }
          const { scratch, tree } = yield* snapshot(worktree);
          const fork = yield* forkPoint(worktree);
          // A file, not a pipe: the patch of a file in another encoding isn't text.
          const patch = path.join(scratch, "patch");
          yield* git(worktree.root, ["diff", "--binary", "--no-color", "--no-ext-diff", `--output=${patch}`, fork, tree]);
          const info = yield* fs.stat(patch).pipe(Effect.mapError((err) => failed("apply", err.message)));
          if (Number(info.size) === 0) {
            return { applied: false, conflicts: [] };
          }
          const { err, code } = yield* exec(repo.value.top, ["apply", "--3way", "--whitespace=nowarn", patch]);
          if (code === 0) {
            return { applied: true, conflicts: [] };
          }
          const conflicts = (yield* git(repo.value.top, ["diff", "--name-only", "--diff-filter=U"])).split("\n").filter(Boolean);
          if (conflicts.length === 0) {
            return yield* failed("apply", err || code);
          }
          return { applied: true, conflicts };
        },
        Effect.scoped,
      );

      /** The worktree's branch; merging and pull requests need one. */
      const branchIn = (worktree: TabWorktree) =>
        worktree.branch === undefined
          ? Effect.fail(new WorktreeError({ message: t("worktree.noBranch", path.basename(worktree.root)) }))
          : Effect.succeed(worktree.branch);

      const commit = Effect.fn("Worktrees.commit")(function* (worktree: TabWorktree, message: string) {
        yield* git(worktree.root, ["add", "--all"]);
        yield* git(worktree.root, ["commit", "--quiet", "-m", message]);
      });

      const baseTop = Effect.fnUntraced(function* (worktree: TabWorktree, command: string) {
        const repo = yield* repoOf(worktree.base);
        return Option.isSome(repo) ? repo.value.top : yield* failed(command, worktree.base);
      });

      const isBaseDirty = Effect.fn("Worktrees.isBaseDirty")(function* (worktree: TabWorktree) {
        const top = yield* baseTop(worktree, "status");
        // Untracked files are no reason to stop: git refuses by itself when the merge would overwrite one.
        return (yield* git(top, ["status", "--porcelain", "--untracked-files=no"])).trim() !== "";
      });

      const merge = Effect.fn("Worktrees.merge")(function* (worktree: TabWorktree) {
        const branch = yield* branchIn(worktree);
        if (yield* isBaseDirty(worktree)) {
          return yield* new WorktreeError({ message: t("worktree.baseDirty", path.basename(worktree.base)) });
        }
        const top = yield* baseTop(worktree, "merge");
        const { err, out, code } = yield* exec(top, ["merge", "--no-edit", branch]);
        if (code === 0) {
          return { conflicts: [] };
        }
        const conflicts = (yield* git(top, ["diff", "--name-only", "--diff-filter=U"])).split("\n").filter(Boolean);
        if (conflicts.length === 0) {
          return yield* failed("merge", err || out.trim() || code);
        }
        return { conflicts };
      });

      const abortMerge = Effect.fn("Worktrees.abortMerge")(function* (worktree: TabWorktree) {
        yield* git(yield* baseTop(worktree, "merge"), ["merge", "--abort"]);
      });

      const prTarget = Effect.fn("Worktrees.prTarget")(function* (worktree: TabWorktree) {
        const branch = yield* branchIn(worktree);
        const remotes = (yield* git(worktree.root, ["remote"])).split("\n").filter(Boolean);
        const baseBranch = (yield* exec(worktree.base, ["symbolic-ref", "--short", "-q", "HEAD"])).out.trim();
        const configured = (key: string) =>
          baseBranch === "" ? Effect.succeed("") : exec(worktree.base, ["config", "--get", `branch.${baseBranch}.${key}`]).pipe(Effect.map(({ out }) => out.trim()));
        const tracked = yield* configured("remote");
        const merged = yield* configured("merge");
        const remote = remotes.includes(tracked) ? tracked : remotes.includes("origin") ? "origin" : remotes[0];
        if (remote === undefined) {
          return yield* new WorktreeError({ message: t("worktree.noRemote") });
        }
        const listed = yield* gh(worktree.root, ["pr", "list", "--head", branch, "--state", "open", "--json", "url", "--limit", "1"]);
        const existing = Option.getOrElse(decodePrList(listed), () => [])[0]?.url;
        const base = remotes.includes(tracked) && merged.startsWith("refs/heads/") ? merged.slice("refs/heads/".length) : undefined;
        return { remote, ...(base === undefined ? {} : { base }), ...(existing === undefined ? {} : { existing }) };
      });

      const prSummary = Effect.fn("Worktrees.prSummary")(function* (worktree: TabWorktree) {
        const fork = yield* forkPoint(worktree);
        const subjects = (yield* git(worktree.root, ["log", "--reverse", "--format=%s", `${fork}..HEAD`])).split("\n").filter(Boolean);
        const stat = yield* git(worktree.root, ["diff", "--stat", "--no-color", "--no-ext-diff", fork, "HEAD"]);
        return { fork, subjects, stat };
      });

      const push = Effect.fn("Worktrees.push")(
        function* (worktree: TabWorktree, remote: string) {
          const branch = yield* branchIn(worktree);
          // With no terminal to ask in, a remote that wants credentials should fail, not hang.
          yield* git(worktree.root, ["push", "--quiet", "--set-upstream", remote, branch], { GIT_TERMINAL_PROMPT: "0" });
        },
        Effect.timeoutOrElse({
          duration: Duration.minutes(REMOTE_TIMEOUT_MINUTES),
          orElse: () => Effect.fail(new WorktreeError({ message: t("worktree.remoteTimedOut", REMOTE_TIMEOUT_MINUTES) })),
        }),
      );

      const createPr = Effect.fn("Worktrees.createPr")(function* (worktree: TabWorktree, { title, body }: PrText, base?: string) {
        const branch = yield* branchIn(worktree);
        const onto = base === undefined ? [] : ["--base", base];
        const out = yield* gh(worktree.root, ["pr", "create", "--head", branch, "--title", title, "--body-file", "-", ...onto], body);
        return out.trim().split("\n").at(-1) ?? "";
      });

      const remove = Effect.fn("Worktrees.remove")(function* (worktree: TabWorktree) {
        if (!isManaged(worktree.root)) {
          return;
        }
        yield* (yield* exists(worktree.root))
          ? git(worktree.base, ["worktree", "remove", "--force", worktree.root])
          : git(worktree.base, ["worktree", "prune"]);
        if (worktree.branch?.startsWith(BRANCH_PREFIX)) {
          yield* git(worktree.base, ["branch", "-D", worktree.branch]);
        }
      });

      return Worktrees.of({
        isRepo: (folder) => repoOf(folder).pipe(Effect.map(Option.isSome)),
        branchOf,
        create,
        nameAfter,
        setup,
        list,
        locate,
        exists,
        restore,
        status,
        diff,
        original,
        apply,
        commit,
        isBaseDirty,
        merge,
        abortMerge,
        prTarget,
        prSummary,
        push,
        createPr,
        remove,
      });
    }),
  );
}
