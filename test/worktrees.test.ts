import { assert, describe, it } from "@effect/vitest";
import * as NodeChildProcessSpawner from "@effect/platform-node-shared/NodeChildProcessSpawner";
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import * as NodePath from "@effect/platform-node-shared/NodePath";
import { Effect, Layer, Option } from "effect";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll } from "vitest";
import * as vscode from "vscode";
import { TabList } from "../src/chat/tabs";
import { TabWorktrees } from "../src/chat/worktrees";
import { ShadowGit } from "../src/checkpoints";
import { ExtensionCtx } from "../src/runtime";
import { intoWorktree, isManaged, parseWorktreeList, Worktrees } from "../src/worktrees";
import { makeExtensionCtx } from "./helpers";

const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "code-acp-worktrees-")));
const realHome = process.env.HOME;

const platform = NodeChildProcessSpawner.layer.pipe(Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)));
const layer = Layer.mergeAll(
  Worktrees.layer,
  ShadowGit.layer.pipe(Layer.provide(Layer.succeed(ExtensionCtx, makeExtensionCtx(path.join(scratch, "storage"))))),
).pipe(Layer.provideMerge(platform));

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });

let count = 0;
/** A repository with one commit holding `a.txt`, `sub/b.txt` and a `.gitignore`. */
const makeRepo = () => {
  const dir = path.join(scratch, `repo-${count++}`);
  fs.mkdirSync(path.join(dir, "sub"), { recursive: true });
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
  fs.writeFileSync(path.join(dir, "sub", "b.txt"), "two\n");
  fs.writeFileSync(path.join(dir, ".gitignore"), "ignored/\n");
  git(dir, "init", "--quiet");
  git(dir, "add", "--all");
  git(dir, "commit", "--quiet", "-m", "init");
  return dir;
};

const created = (folder: string) =>
  Worktrees.use((worktrees) => worktrees.create(folder)).pipe(Effect.map(Option.getOrThrow));

beforeAll(() => {
  process.env.HOME = path.join(scratch, "home");
  fs.mkdirSync(process.env.HOME);
});
afterAll(() => {
  process.env.HOME = realHome;
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe("worktree helpers", () => {
  it("parses a listing, leaving out bare and prunable entries", () => {
    const output = [
      "worktree /r\nHEAD abc\nbranch refs/heads/main\n",
      "worktree /b\nbare\n",
      "worktree /d\nHEAD abc\ndetached\n",
      "worktree /gone\nHEAD abc\nbranch refs/heads/x\nprunable gitdir file points to non-existent location\n",
      "",
    ].join("\n");
    assert.deepStrictEqual(parseWorktreeList(output), [{ root: "/r", branch: "main" }, { root: "/d" }]);
  });

  it("maps a file of the base folder into the worktree", () => {
    assert.strictEqual(intoWorktree("/repo/src/a.ts", "/repo", "/wt"), "/wt/src/a.ts");
    assert.strictEqual(intoWorktree("/repo", "/repo", "/wt"), "/wt");
    assert.isUndefined(intoWorktree("/other/a.ts", "/repo", "/wt"));
    assert.isUndefined(intoWorktree("/repo-2/a.ts", "/repo", "/wt"));
  });

  it("only counts worktrees in its own folder as managed", () => {
    assert.isTrue(isManaged("/home/u/.code-acp/worktrees/r-1/abc"));
    assert.isFalse(isManaged("/home/u/projects/worktree"));
  });

  it("keeps a tab's worktree across a reload", () => {
    const worktree = { root: "/home/u/.code-acp/worktrees/r/abc", branch: "code-acp/abc", base: "/r" };
    const list = new TabList(undefined, () => "/r");
    list.active.cwd = worktree.root;
    list.active.worktree = worktree;
    const restored = new TabList(list.saved, () => "/r");
    assert.deepStrictEqual(restored.active.worktree, worktree);
    assert.strictEqual(restored.active.cwd, worktree.root);
    assert.deepStrictEqual(restored.info[0]!.worktree, worktree);
  });
});

describe("Worktrees", () => {
  it.effect("creates nothing outside a git repository", () =>
    Effect.gen(function* () {
      const dir = path.join(scratch, "plain");
      fs.mkdirSync(dir, { recursive: true });
      const worktrees = yield* Worktrees;
      assert.isFalse(yield* worktrees.isRepo(dir));
      assert.isTrue(Option.isNone(yield* worktrees.create(dir)));
    }).pipe(Effect.provide(layer)),
  );

  it.effect("creates a worktree on its own branch, outside the repository", () =>
    Effect.gen(function* () {
      const repo = makeRepo();
      const { worktree, cwd } = yield* created(repo);
      assert.strictEqual(cwd, worktree.root);
      assert.isTrue(isManaged(worktree.root));
      assert.isTrue(fs.existsSync(path.join(worktree.root, "a.txt")));
      assert.match(worktree.branch!, /^code-acp\//);
      assert.strictEqual(git(worktree.root, "rev-parse", "--abbrev-ref", "HEAD").trim(), worktree.branch);
      // The base folder is untouched.
      assert.strictEqual(git(repo, "status", "--porcelain"), "");
      assert.deepStrictEqual(
        (yield* Worktrees.use((w) => w.list(repo))).map((placed) => placed.worktree),
        [worktree],
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("runs a tab of a folder inside the repository in the same folder of the worktree", () =>
    Effect.gen(function* () {
      const repo = makeRepo();
      const { worktree, cwd } = yield* created(path.join(repo, "sub"));
      assert.strictEqual(cwd, path.join(worktree.root, "sub"));
      assert.strictEqual(worktree.base, path.join(repo, "sub"));
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reads what is checked out: the branch, a short commit when detached, nothing outside git", () =>
    Effect.gen(function* () {
      const repo = makeRepo();
      const { worktree } = yield* created(repo);
      const worktrees = yield* Worktrees;
      assert.strictEqual(yield* worktrees.branchOf(worktree.root), worktree.branch);
      git(worktree.root, "checkout", "--quiet", "--detach");
      assert.strictEqual(yield* worktrees.branchOf(worktree.root), git(repo, "rev-parse", "--short", "HEAD").trim());
      const plain = path.join(scratch, `plain-${count++}`);
      fs.mkdirSync(plain);
      assert.isUndefined(yield* worktrees.branchOf(plain));
    }).pipe(Effect.provide(layer)),
  );

  it.effect("counts uncommitted files and commits since the fork", () =>
    Effect.gen(function* () {
      const repo = makeRepo();
      const { worktree } = yield* created(repo);
      const worktrees = yield* Worktrees;
      assert.deepStrictEqual(yield* worktrees.status(worktree), { changed: 0, commits: 0 });
      fs.writeFileSync(path.join(worktree.root, "new.txt"), "x\n");
      assert.deepStrictEqual(yield* worktrees.status(worktree), { changed: 1, commits: 0 });
      git(worktree.root, "add", "--all");
      git(worktree.root, "commit", "--quiet", "-m", "work");
      assert.deepStrictEqual(yield* worktrees.status(worktree), { changed: 0, commits: 1 });
      // Commits on the base folder's branch after the fork don't count; merged work doesn't either.
      git(repo, "merge", "--quiet", worktree.branch!);
      assert.deepStrictEqual(yield* worktrees.status(worktree), { changed: 0, commits: 0 });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("applies committed and uncommitted work to the base folder, and leaves the worktree as it is", () =>
    Effect.gen(function* () {
      const repo = makeRepo();
      const { worktree } = yield* created(repo);
      fs.writeFileSync(path.join(worktree.root, "a.txt"), "one\ncommitted\n");
      git(worktree.root, "commit", "--quiet", "-am", "work");
      fs.writeFileSync(path.join(worktree.root, "sub", "b.txt"), "two\nuncommitted\n");
      fs.writeFileSync(path.join(worktree.root, "new.txt"), "untracked\n");
      fs.rmSync(path.join(worktree.root, ".gitignore"));
      fs.writeFileSync(path.join(worktree.root, "latin1.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));

      const before = git(worktree.root, "status", "--porcelain");
      const result = yield* Worktrees.use((w) => w.apply(worktree));
      assert.deepStrictEqual(result, { applied: true, conflicts: [] });
      assert.strictEqual(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), "one\ncommitted\n");
      assert.strictEqual(fs.readFileSync(path.join(repo, "sub", "b.txt"), "utf8"), "two\nuncommitted\n");
      assert.strictEqual(fs.readFileSync(path.join(repo, "new.txt"), "utf8"), "untracked\n");
      assert.isFalse(fs.existsSync(path.join(repo, ".gitignore")));
      assert.deepStrictEqual([...fs.readFileSync(path.join(repo, "latin1.txt"))], [0x63, 0x61, 0x66, 0xe9, 0x0a]);
      assert.strictEqual(git(worktree.root, "status", "--porcelain"), before);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("has nothing to apply from a clean worktree", () =>
    Effect.gen(function* () {
      const { worktree } = yield* created(makeRepo());
      assert.deepStrictEqual(yield* Worktrees.use((w) => w.apply(worktree)), { applied: false, conflicts: [] });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reports conflicts with the base folder's newer commits", () =>
    Effect.gen(function* () {
      const repo = makeRepo();
      const { worktree } = yield* created(repo);
      fs.writeFileSync(path.join(worktree.root, "a.txt"), "theirs\n");
      fs.writeFileSync(path.join(repo, "a.txt"), "ours\n");
      git(repo, "commit", "--quiet", "-am", "ours");
      assert.deepStrictEqual(yield* Worktrees.use((w) => w.apply(worktree)), { applied: true, conflicts: ["a.txt"] });
      assert.include(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), "<<<<<<<");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("fails and changes nothing when the base folder's own edits are in the way", () =>
    Effect.gen(function* () {
      const repo = makeRepo();
      const { worktree } = yield* created(repo);
      fs.writeFileSync(path.join(worktree.root, "a.txt"), "theirs\n");
      fs.writeFileSync(path.join(worktree.root, "new.txt"), "x\n");
      fs.writeFileSync(path.join(repo, "a.txt"), "local edit\n");
      const exit = yield* Worktrees.use((w) => w.apply(worktree)).pipe(Effect.flip);
      assert.strictEqual(exit._tag, "WorktreeError");
      assert.strictEqual(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), "local edit\n");
      assert.isFalse(fs.existsSync(path.join(repo, "new.txt")));
    }).pipe(Effect.provide(layer)),
  );

  it.effect("deletes a managed worktree with its branch, but never another one", () =>
    Effect.gen(function* () {
      const repo = makeRepo();
      const { worktree } = yield* created(repo);
      const worktrees = yield* Worktrees;
      fs.writeFileSync(path.join(worktree.root, "new.txt"), "x\n");
      yield* worktrees.remove(worktree);
      assert.isFalse(fs.existsSync(worktree.root));
      assert.strictEqual(git(repo, "branch", "--list", worktree.branch!), "");

      const own = path.join(scratch, `own-${count++}`);
      git(repo, "worktree", "add", "--quiet", "-b", "mine", own);
      yield* worktrees.remove({ root: own, branch: "mine", base: repo });
      assert.isTrue(fs.existsSync(own));
      assert.notStrictEqual(git(repo, "branch", "--list", "mine"), "");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("brings a deleted folder back on its branch, with its commits", () =>
    Effect.gen(function* () {
      const repo = makeRepo();
      const { worktree } = yield* created(repo);
      const worktrees = yield* Worktrees;
      fs.writeFileSync(path.join(worktree.root, "new.txt"), "x\n");
      git(worktree.root, "add", "--all");
      git(worktree.root, "commit", "--quiet", "-m", "work");
      fs.rmSync(worktree.root, { recursive: true });
      assert.isTrue(yield* worktrees.restore(worktree));
      assert.isTrue(fs.existsSync(path.join(worktree.root, "new.txt")));
      // The branch is gone as well: it can't come back.
      yield* worktrees.remove(worktree);
      assert.isFalse(yield* worktrees.restore(worktree));
    }).pipe(Effect.provide(layer)),
  );

  it.effect("finds the worktree holding a session's folder", () =>
    Effect.gen(function* () {
      const repo = makeRepo();
      const { worktree } = yield* created(repo);
      const worktrees = yield* Worktrees;
      assert.deepStrictEqual(yield* worktrees.locate([repo], worktree.root), worktree);
      assert.deepStrictEqual(yield* worktrees.locate([repo], path.join(worktree.root, "sub")), worktree);
      assert.isUndefined(yield* worktrees.locate([repo], repo));
    }).pipe(Effect.provide(layer)),
  );

  it.effect("snapshots a worktree without its .git file, and forgets the snapshots", () =>
    Effect.gen(function* () {
      const { worktree } = yield* created(makeRepo());
      const shadow = yield* ShadowGit;
      const before = yield* shadow.snapshot(worktree.root);
      fs.writeFileSync(path.join(worktree.root, "new.txt"), "x\n");
      const after = yield* shadow.snapshot(worktree.root);
      assert.deepStrictEqual(
        (yield* shadow.diff(worktree.root, before, after)).map((change) => change.file),
        ["new.txt"],
      );
      assert.isNull(yield* shadow.show(worktree.root, after, ".git"));
      yield* shadow.forget(worktree.root);
      assert.isTrue((yield* Effect.flip(shadow.show(worktree.root, after, "a.txt")))._tag === "CheckpointError");
    }).pipe(Effect.provide(layer)),
  );
});

describe("TabWorktrees", () => {
  /** The controller with two tabs on `tabs`; answers `reply` to whatever it asks, and records the questions. */
  const makeController = (reply?: string) => {
    const asked: string[] = [];
    vscode.window.showWarningMessage = (async (message: string) => {
      asked.push(message);
      return reply;
    }) as never;
    const tabs = new TabList(undefined, () => "/w");
    const controller = new TabWorktrees({
      tabs: () => tabs,
      postTab: () => {},
      postTabs: () => {},
      status: () => {},
      confirmStartOver: () => Effect.succeed(true),
      startOver: () => Effect.void,
    });
    return { asked, tabs, controller, tab: tabs.active };
  };

  it.effect("deletes a worktree with nothing to lose without asking", () =>
    Effect.gen(function* () {
      const { worktree } = yield* created(makeRepo());
      const { asked, controller, tab } = makeController();
      tab.worktree = worktree;
      assert.strictEqual(yield* controller.askRelease(tab), "delete");
      assert.deepStrictEqual(asked, []);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("asks before deleting uncommitted work, and cancelling the dialog cancels leaving", () =>
    Effect.gen(function* () {
      const { worktree } = yield* created(makeRepo());
      fs.writeFileSync(path.join(worktree.root, "new.txt"), "x\n");
      const answers = [
        ["Delete Worktree", "delete"],
        ["Keep Worktree", "keep"],
        [undefined, "cancel"],
      ] as const;
      for (const [reply, fate] of answers) {
        const { asked, controller, tab } = makeController(reply);
        tab.worktree = worktree;
        assert.strictEqual(yield* controller.askRelease(tab), fate);
        assert.strictEqual(asked.length, 1);
      }
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps a worktree another tab runs in, or that the user made, without asking", () =>
    Effect.gen(function* () {
      const repo = makeRepo();
      const { worktree } = yield* created(repo);
      fs.writeFileSync(path.join(worktree.root, "new.txt"), "x\n");
      const { asked, controller, tab, tabs } = makeController("Delete Worktree");
      tab.worktree = worktree;
      tabs.add(worktree.root).worktree = worktree;
      assert.strictEqual(yield* controller.askRelease(tab), "keep");

      const own = path.join(scratch, `own-${count++}`);
      git(repo, "worktree", "add", "--quiet", "-b", `mine-${count}`, own);
      const alone = makeController("Delete Worktree");
      alone.tab.worktree = { root: own, base: repo };
      assert.strictEqual(yield* alone.controller.askRelease(alone.tab), "keep");
      assert.deepStrictEqual([...asked, ...alone.asked], []);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("points attachments of base folder files at the worktree's copy", () =>
    Effect.gen(function* () {
      const repo = makeRepo();
      const { worktree, cwd } = yield* created(repo);
      fs.mkdirSync(path.join(repo, "ignored"));
      fs.writeFileSync(path.join(repo, "ignored", "only-here.txt"), "x\n");
      const { controller, tab } = makeController();
      tab.worktree = worktree;
      tab.cwd = cwd;
      const attach = (file: string) => controller.localize(tab, { kind: "uri", uri: `file://${file}`, name: "f" });
      assert.strictEqual((yield* attach(path.join(repo, "a.txt"))).uri, `file://${path.join(worktree.root, "a.txt")}`);
      const ignored = path.join(repo, "ignored", "only-here.txt");
      assert.strictEqual((yield* attach(ignored)).uri, `file://${ignored}`);
      const text = { kind: "problems", name: "p", text: "x" } as const;
      assert.deepStrictEqual(yield* controller.localize(tab, text), text);
    }).pipe(Effect.provide(layer)),
  );
});
