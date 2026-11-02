import { Context, Effect, FileSystem, Layer, Option, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { createHash, randomBytes } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { t } from "./i18n";
import { messageOf } from "./runtime";

/** Branches of the worktrees the extension creates. */
const BRANCH_PREFIX = "code-acp/";

/** Where the extension's worktrees live, outside the repository so that they never show up in it. */
const MANAGED_DIR = path.join(".code-acp", "worktrees");

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

export interface AppliedWorktree {
  readonly applied: boolean;
  /** Files left with conflict markers in the base folder. */
  readonly conflicts: ReadonlyArray<string>;
}

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

/** The git worktrees chat tabs run in. Listings come from git, so worktrees made outside the extension show up too. */
export class Worktrees extends Context.Service<Worktrees, {
  /** Whether `folder` is in a git work tree. */
  isRepo(folder: string): Effect.Effect<boolean>;
  /** The branch checked out in `folder`, else its short commit when HEAD is detached; undefined outside git. */
  branchOf(folder: string): Effect.Effect<string | undefined>;
  /** A new worktree on a new branch from the HEAD of `folder`; none when `folder` isn't in a git work tree. */
  create(folder: string): Effect.Effect<Option.Option<PlacedWorktree>, WorktreeError>;
  /** The other worktrees of the repository of `folder`, which becomes their base. */
  list(folder: string): Effect.Effect<ReadonlyArray<PlacedWorktree>, WorktreeError>;
  /** The worktree of one of `folders`' repositories holding `cwd`. */
  locate(folders: ReadonlyArray<string>, cwd: string): Effect.Effect<TabWorktree | undefined>;
  exists(folder: string): Effect.Effect<boolean>;
  /** Puts a missing worktree the extension created back on its branch; false when it can't be. */
  restore(worktree: TabWorktree): Effect.Effect<boolean>;
  status(worktree: TabWorktree): Effect.Effect<WorktreeStatus, WorktreeError>;
  /**
   * Brings what the worktree holds, committed or not, into its base folder as staged changes. The worktree stays
   * as it is. Nothing is changed when the base folder's own changes are in the way.
   */
  apply(worktree: TabWorktree): Effect.Effect<AppliedWorktree, WorktreeError>;
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
        function* (cwd: string, args: ReadonlyArray<string>, env?: Record<string, string>) {
          const handle = yield* spawner.spawn(ChildProcess.make("git", args, { cwd, env, extendEnv: true }));
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

      const create = Effect.fn("Worktrees.create")(function* (folder: string) {
        const repo = yield* repoOf(folder);
        if (Option.isNone(repo)) {
          return Option.none<PlacedWorktree>();
        }
        const { top, prefix } = repo.value;
        const slug = randomBytes(3).toString("hex");
        const repoDir = `${path.basename(top)}-${createHash("sha256").update(top).digest("hex").slice(0, 8)}`;
        const dir = path.join(os.homedir(), MANAGED_DIR, repoDir, slug);
        const branch = `${BRANCH_PREFIX}${slug}`;
        yield* fs.makeDirectory(path.dirname(dir), { recursive: true }).pipe(Effect.mapError((err) => failed("worktree", err.message)));
        yield* git(folder, ["worktree", "add", "--quiet", "-b", branch, dir, "HEAD"]);
        // As git reports it, with symbolic links resolved, to match its listings.
        const root = (yield* git(dir, ["rev-parse", "--show-toplevel"])).trim();
        const cwd = path.resolve(root, prefix);
        // A folder with nothing committed in it isn't in the new worktree.
        yield* fs.makeDirectory(cwd, { recursive: true }).pipe(Effect.mapError((err) => failed("worktree", err.message)));
        return Option.some<PlacedWorktree>({ worktree: { root, branch, base: folder }, cwd });
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

      const status = Effect.fn("Worktrees.status")(function* (worktree: TabWorktree) {
        const changed = (yield* git(worktree.root, ["status", "--porcelain"])).split("\n").filter(Boolean).length;
        const fork = yield* forkPoint(worktree);
        const commits = Number((yield* git(worktree.root, ["rev-list", "--count", `${fork}..HEAD`])).trim());
        return { changed, commits };
      });

      const apply = Effect.fn("Worktrees.apply")(
        function* (worktree: TabWorktree) {
          const repo = yield* repoOf(worktree.base);
          if (Option.isNone(repo)) {
            return yield* failed("apply", worktree.base);
          }
          const scratch = yield* fs.makeTempDirectoryScoped().pipe(Effect.mapError((err) => failed("apply", err.message)));
          // On a scratch index, so what the worktree has staged stays as it is.
          const env = { GIT_INDEX_FILE: path.join(scratch, "index") };
          yield* git(worktree.root, ["read-tree", "HEAD"], env);
          yield* git(worktree.root, ["add", "--all"], env);
          const tree = (yield* git(worktree.root, ["write-tree"], env)).trim();
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
        list,
        locate,
        exists,
        restore,
        status,
        apply,
        remove,
      });
    }),
  );
}
