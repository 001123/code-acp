import { Context, Effect, FileSystem, Layer, Schema, Semaphore, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { createHash } from "node:crypto";
import * as path from "node:path";
import { t } from "./i18n";
import { ExtensionCtx, messageOf } from "./runtime";

/** A file that differs between two snapshots. `file` is relative to the work tree, with "/" separators. */
export interface TreeChange {
  readonly file: string;
  readonly status: "added" | "modified" | "deleted";
  readonly added: number;
  readonly removed: number;
  readonly binary: boolean;
}

export class CheckpointError extends Schema.TaggedError<CheckpointError>()("CheckpointError", {
  message: Schema.String,
}) {}

/**
 * Snapshots of a work tree in a git repository of the extension's own, so the files an agent changes can be
 * compared and put back however it changed them (its own tools, a terminal, the client's fs). The user's
 * repository is never touched; files their .gitignore excludes are not tracked. Snapshots are git trees,
 * named by hash and kept as long as the repository is.
 */
export class ShadowGit extends Context.Service<ShadowGit, {
  /** Snapshots `root` as it is on disk now. */
  snapshot(root: string): Effect.Effect<string, CheckpointError>;
  /** What differs from snapshot `from` to snapshot `to`. */
  diff(root: string, from: string, to: string): Effect.Effect<ReadonlyArray<TreeChange>, CheckpointError>;
  /** A file's content in a snapshot; null when it is not in it. */
  show(root: string, tree: string, file: string): Effect.Effect<string | null, CheckpointError>;
  /** Puts `files` back on disk as they are in snapshot `tree`; files not in it are deleted. */
  restore(root: string, tree: string, files: ReadonlyArray<string>): Effect.Effect<void, CheckpointError>;
  /** Snapshot `base` with `files` taken from snapshot `from`. */
  merge(root: string, base: string, from: string, files: ReadonlyArray<string>): Effect.Effect<string, CheckpointError>;
}>()("code-acp/ShadowGit") {
  static readonly layer = Layer.effect(
    ShadowGit,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fs = yield* FileSystem.FileSystem;
      const context = yield* ExtensionCtx;
      const storage = path.join((context.storageUri ?? context.globalStorageUri).fsPath, "checkpoints");
      // One work tree's commands share an index; git fails when two write it at once.
      const lock = Semaphore.makeUnsafe(1);
      const ready = new Set<string>();

      const gitDirOf = (root: string) =>
        path.join(storage, createHash("sha256").update(root).digest("hex").slice(0, 16));

      /** Runs git in `cwd`; fails unless it exits with code 0. */
      const run = Effect.fn("ShadowGit.run")(
        function* (cwd: string, args: ReadonlyArray<string>, env?: Record<string, string>) {
          const handle = yield* spawner.spawn(ChildProcess.make("git", args, { cwd, env, extendEnv: true }));
          const [out, err, code] = yield* Effect.all(
            [
              Stream.mkString(Stream.decodeText(handle.stdout)),
              Stream.mkString(Stream.decodeText(handle.stderr)),
              handle.exitCode,
            ],
            { concurrency: "unbounded" },
          );
          if (code !== 0) {
            const command = args.find((arg) => !arg.startsWith("-") && !arg.includes("=")) ?? "git";
            return yield* new CheckpointError({ message: t("checkpoints.gitFailed", command, err.trim() || code) });
          }
          return out;
        },
        Effect.scoped,
        Effect.mapError((err) =>
          err._tag === "CheckpointError" ? err : new CheckpointError({ message: t("checkpoints.gitFailed", "git", messageOf(err)) }),
        ),
      );

      /** Runs git on the shadow repository of `root`, with `root` as its work tree. */
      const git = (root: string, args: ReadonlyArray<string>, env?: Record<string, string>) =>
        run(
          root,
          [
            `--git-dir=${gitDirOf(root)}`,
            `--work-tree=${root}`,
            "--literal-pathspecs",
            "-c",
            "core.autocrlf=false",
            "-c",
            "core.safecrlf=false",
            "-c",
            "core.longpaths=true",
            ...args,
          ],
          env,
        );

      const init = Effect.fn("ShadowGit.init")(function* (root: string) {
        if (ready.has(root)) {
          return;
        }
        const gitDir = gitDirOf(root);
        if (!(yield* fs.exists(path.join(gitDir, "HEAD")).pipe(Effect.orElseSucceed(() => false)))) {
          yield* fs.makeDirectory(gitDir, { recursive: true }).pipe(Effect.ignore);
          yield* run(root, ["init", "--quiet", "--bare", gitDir]);
          for (const [key, value] of [
            ["core.bare", "false"],
            // Snapshots are only reachable by the hashes the chat saves: never prune them.
            ["gc.auto", "0"],
            ["gc.pruneExpire", "never"],
            ["core.quotepath", "false"],
          ]) {
            yield* git(root, ["config", key!, value!]);
          }
          // On top of the work tree's own .gitignore files.
          yield* fs
            .writeFileString(
              path.join(gitDir, "info", "exclude"),
              ["node_modules/", ".venv/", "venv/", "__pycache__/", ".DS_Store", ".git/", ""].join("\n"),
            )
            .pipe(Effect.ignore);
        }
        ready.add(root);
      });

      /** The index after taking in the work tree as it is now. */
      const addAll = (root: string) => git(root, ["add", "--all", "--ignore-errors", "--", "."]).pipe(Effect.ignore);

      const withLock = <A, E, R>(effect: Effect.Effect<A, E, R>) => Semaphore.withPermits(lock, 1)(effect);

      const snapshot = Effect.fn("ShadowGit.snapshot")(function* (root: string) {
        yield* init(root);
        yield* addAll(root);
        return (yield* git(root, ["write-tree"])).trim();
      });

      const diff = Effect.fn("ShadowGit.diff")(function* (root: string, from: string, to: string) {
        if (from === to) {
          return [];
        }
        const statuses = (yield* git(root, ["diff-tree", "-r", "-z", "--no-renames", "--name-status", from, to])).split("\0");
        const status = new Map<string, TreeChange["status"]>();
        for (let i = 0; i + 1 < statuses.length; i += 2) {
          const code = statuses[i]!;
          status.set(statuses[i + 1]!, code === "A" ? "added" : code === "D" ? "deleted" : "modified");
        }
        const changes: TreeChange[] = [];
        // "<added>\t<removed>\t<file>\0"; binary files count "-".
        for (const entry of (yield* git(root, ["diff-tree", "-r", "-z", "--no-renames", "--numstat", from, to])).split("\0")) {
          const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(entry);
          if (!match) {
            continue;
          }
          const [, added, removed, file] = match;
          changes.push({
            file: file!,
            status: status.get(file!) ?? "modified",
            added: added === "-" ? 0 : Number(added),
            removed: removed === "-" ? 0 : Number(removed),
            binary: added === "-",
          });
        }
        return changes;
      });

      const show = Effect.fn("ShadowGit.show")(function* (root: string, tree: string, file: string) {
        const listed = yield* git(root, ["ls-tree", "-z", tree, "--", file]);
        if (!listed) {
          return null;
        }
        return yield* git(root, ["cat-file", "blob", `${tree}:${file}`]);
      });

      /** Pathspecs are passed as arguments; batches keep the command line short (Windows allows 32k chars). */
      const batches = (files: ReadonlyArray<string>) => {
        const out: string[][] = [];
        for (let i = 0; i < files.length; i += 100) {
          out.push(files.slice(i, i + 100));
        }
        return out;
      };

      const restore = Effect.fn("ShadowGit.restore")(function* (root: string, tree: string, files: ReadonlyArray<string>) {
        yield* init(root);
        // Files created since the snapshot must be in the index for restore to delete them.
        yield* addAll(root);
        for (const batch of batches(files)) {
          yield* git(root, ["restore", `--source=${tree}`, "--staged", "--worktree", "--", ...batch]);
        }
      });

      const merge = Effect.fn("ShadowGit.merge")(function* (
        root: string,
        base: string,
        from: string,
        files: ReadonlyArray<string>,
      ) {
        // A scratch index, so the shared one keeps matching the work tree.
        const index = path.join(gitDirOf(root), `merge-${process.pid}.index`);
        const env = { GIT_INDEX_FILE: index };
        yield* git(root, ["read-tree", base], env);
        for (const file of files) {
          const listed = (yield* git(root, ["ls-tree", "-z", from, "--", file])).replace(/\0$/, "");
          // "<mode> blob <hash>\t<file>"
          const match = /^(\d+) \w+ ([0-9a-f]+)\t/.exec(listed);
          yield* match
            ? git(root, ["update-index", "--add", "--cacheinfo", `${match[1]},${match[2]},${file}`], env)
            : git(root, ["update-index", "--force-remove", "--", file], env);
        }
        const tree = (yield* git(root, ["write-tree"], env)).trim();
        yield* fs.remove(index).pipe(Effect.ignore);
        return tree;
      });

      return ShadowGit.of({
        snapshot: (root) => withLock(snapshot(root)),
        diff: (root, from, to) => withLock(diff(root, from, to)),
        show: (root, tree, file) => withLock(show(root, tree, file)),
        restore: (root, tree, files) => withLock(restore(root, tree, files)),
        merge: (root, base, from, files) => withLock(merge(root, base, from, files)),
      });
    }),
  );
}
