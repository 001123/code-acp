import { assert, describe, it } from "@effect/vitest";
import * as NodeChildProcessSpawner from "@effect/platform-node-shared/NodeChildProcessSpawner";
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import * as NodePath from "@effect/platform-node-shared/NodePath";
import { Effect, Layer, Option } from "effect";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll } from "vitest";
import * as vscode from "vscode";
import { TabList, type Tab } from "../src/chat/tabs";
import { TabWorktrees } from "../src/chat/worktrees";
import { ShadowGit } from "../src/checkpoints";
import { ExtensionCtx } from "../src/runtime";
import {
  attemptBranchName,
  branchSlug,
  fallbackPrText,
  freeBranchName,
  intoWorktree,
  isManaged,
  outermostEntries,
  parseNumstat,
  parsePrText,
  parseWorktreeList,
  Worktrees,
  type ProjectCommand,
} from "../src/worktrees";
import { makeExtensionCtx } from "./helpers";
import { __test, Uri, workspace } from "./stubs/vscode";

const PROJECT_COMMAND = "codeAcp.worktreeProjectSetupCommand";
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "code-acp-worktrees-")));
const realHome = process.env.HOME;

const platform = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
);
const layer = Layer.mergeAll(
  Worktrees.layer,
  ShadowGit.layer.pipe(Layer.provide(Layer.succeed(ExtensionCtx, makeExtensionCtx(path.join(scratch, "storage"))))),
).pipe(Layer.provideMerge(platform));

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });

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
afterEach(() => {
  __test.setSetting("codeAcp.worktreeCopyFiles", []);
  __test.setSetting("codeAcp.worktreeSetupCommand", "");
  __test.setWorkspaceSetting(PROJECT_COMMAND, undefined);
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

  it("keeps the outermost entries of a listing, without their slashes", () => {
    assert.deepStrictEqual(
      outermostEntries([".env", "ignored/deep/", "ignored/deep/.env", "ignored/deeper", "node_modules/"]),
      [".env", "ignored/deep", "ignored/deeper", "node_modules"],
    );
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

describe("branch names", () => {
  it("makes a slug of the first line, without accents", () => {
    assert.strictEqual(branchSlug("Sửa lỗi đăng nhập\nvà thêm test"), "sua-loi-dang-nhap");
    assert.strictEqual(branchSlug("  Fix the login timeout in the session store"), "fix-the-login-timeout-in");
    assert.strictEqual(branchSlug("修复 login"), "login");
    assert.isUndefined(branchSlug("修复 🎉"));
    assert.isUndefined(branchSlug(""));
  });

  it("cuts a slug without leaving a dash at the end", () => {
    assert.strictEqual(branchSlug("abcd efgh", 5), "abcd");
    assert.strictEqual(branchSlug("a".repeat(100))?.length, 40);
  });

  it("puts the branches of a comparison in a folder of their own", () => {
    assert.strictEqual(
      attemptBranchName("Fix login", "Gemini 4 Argon · High"),
      "compare/fix-login-gemini-4-argon-high",
    );
    assert.strictEqual(attemptBranchName("", "gemini"), "compare/gemini");
    assert.strictEqual(attemptBranchName("Fix login", ""), "compare/fix-login");
    assert.strictEqual(attemptBranchName("", ""), "compare/attempt");
  });

  it("numbers a name that is taken, and never gives the one of the comparisons' folder", () => {
    assert.strictEqual(freeBranchName("fix", new Set()), "fix");
    assert.strictEqual(freeBranchName("fix", new Set(["fix", "fix-2"])), "fix-3");
    assert.strictEqual(freeBranchName("compare", new Set()), "compare-2");
  });
});

describe("Worktrees", () => {
  it.effect("names a new worktree's branch and folder after the prompt", () =>
    Effect.gen(function* () {
      const dir = makeRepo();
      const { worktree, cwd } = yield* created(dir);
      assert.match(worktree.branch!, /^code-acp\/[0-9a-f]{6}$/);
      const named = yield* Worktrees.use((worktrees) => worktrees.nameAfter(worktree, "Sửa lỗi đăng nhập", true));
      assert.strictEqual(named.branch, "code-acp/sua-loi-dang-nhap");
      assert.strictEqual(path.basename(named.root), "sua-loi-dang-nhap");
      assert.isFalse(fs.existsSync(cwd));
      assert.strictEqual(git(named.root, "symbolic-ref", "--short", "HEAD").trim(), named.branch);
      // Named once; a later prompt doesn't change it.
      assert.deepStrictEqual(
        yield* Worktrees.use((worktrees) => worktrees.nameAfter(named, "something else", true)),
        named,
      );
      yield* Worktrees.use((worktrees) => worktrees.remove(named));
      assert.notInclude(git(dir, "branch"), "sua-loi");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("numbers the branch when the name is taken", () =>
    Effect.gen(function* () {
      const dir = makeRepo();
      const nameNew = created(dir).pipe(
        Effect.flatMap(({ worktree }) => Worktrees.use((worktrees) => worktrees.nameAfter(worktree, "fix it", true))),
      );
      const first = yield* nameNew;
      const second = yield* nameNew;
      assert.strictEqual(first.branch, "code-acp/fix-it");
      assert.strictEqual(second.branch, "code-acp/fix-it-2");
      assert.strictEqual(path.basename(second.root), "fix-it-2");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps the folder when asked to, or when a setup command ran in it", () =>
    Effect.gen(function* () {
      const dir = makeRepo();
      const { worktree } = yield* created(dir);
      const shared = yield* Worktrees.use((worktrees) => worktrees.nameAfter(worktree, "fix it", false));
      assert.strictEqual(shared.branch, "code-acp/fix-it");
      assert.strictEqual(shared.root, worktree.root);
      const other = (yield* created(dir)).worktree;
      yield* Effect.acquireUseRelease(
        Effect.sync(() => __test.setSetting("codeAcp.worktreeSetupCommand", "true")),
        () =>
          Effect.gen(function* () {
            const named = yield* Worktrees.use((worktrees) => worktrees.nameAfter(other, "fix more", true));
            assert.strictEqual(named.branch, "code-acp/fix-more");
            assert.strictEqual(named.root, other.root);
          }),
        () => Effect.sync(() => __test.setSetting("codeAcp.worktreeSetupCommand", "")),
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("names a comparison's folder after its branch", () =>
    Effect.gen(function* () {
      const dir = makeRepo();
      const { worktree } = yield* Worktrees.use((worktrees) => worktrees.create(dir, "compare/fix-gemini")).pipe(
        Effect.map(Option.getOrThrow),
      );
      assert.strictEqual(path.basename(worktree.root), "fix-gemini");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("leaves a branch with commits, or with nothing to name it after", () =>
    Effect.gen(function* () {
      const dir = makeRepo();
      const { worktree, cwd } = yield* created(dir);
      assert.deepStrictEqual(yield* Worktrees.use((worktrees) => worktrees.nameAfter(worktree, "🎉", true)), worktree);
      fs.writeFileSync(path.join(cwd, "new.txt"), "x\n");
      git(cwd, "add", "--all");
      git(cwd, "commit", "--quiet", "-m", "work");
      assert.deepStrictEqual(
        yield* Worktrees.use((worktrees) => worktrees.nameAfter(worktree, "fix it", true)),
        worktree,
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("leaves a worktree the user made", () =>
    Effect.gen(function* () {
      const dir = makeRepo();
      const root = path.join(scratch, `own-${count++}`);
      git(dir, "worktree", "add", "--quiet", "-b", "code-acp/abc123", root);
      const worktree = { root: fs.realpathSync(root), branch: "code-acp/abc123", base: dir };
      assert.deepStrictEqual(
        yield* Worktrees.use((worktrees) => worktrees.nameAfter(worktree, "fix it", true)),
        worktree,
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("creates a worktree on a branch of the given name, in a folder of its own", () =>
    Effect.gen(function* () {
      const dir = makeRepo();
      const create = Worktrees.use((worktrees) => worktrees.create(dir, "compare/fix-gemini")).pipe(
        Effect.map(Option.getOrThrow),
      );
      const first = yield* create;
      const second = yield* create;
      assert.strictEqual(first.worktree.branch, "code-acp/compare/fix-gemini");
      assert.strictEqual(second.worktree.branch, "code-acp/compare/fix-gemini-2");
      assert.notStrictEqual(first.worktree.root, second.worktree.root);
      yield* Worktrees.use((worktrees) => worktrees.remove(first.worktree));
      assert.notInclude(git(dir, "branch"), "code-acp/compare/fix-gemini\n");
    }).pipe(Effect.provide(layer)),
  );

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

  it.effect("lists what a worktree changed, committed or not, against the commit it forked off", () =>
    Effect.gen(function* () {
      const repo = makeRepo();
      const { worktree } = yield* created(repo);
      const worktrees = yield* Worktrees;
      assert.deepStrictEqual(yield* worktrees.diff(worktree), []);
      fs.writeFileSync(path.join(worktree.root, "a.txt"), "one\nmore\n");
      git(worktree.root, "add", "a.txt");
      git(worktree.root, "commit", "--quiet", "-m", "more");
      fs.rmSync(path.join(worktree.root, "sub", "b.txt"));
      fs.writeFileSync(path.join(worktree.root, "new name.txt"), "new\n");
      fs.writeFileSync(path.join(worktree.root, "data.bin"), Buffer.from([0, 1, 2, 0]));
      const before = git(worktree.root, "status", "--porcelain");
      assert.deepStrictEqual(yield* worktrees.diff(worktree), [
        { path: "a.txt", added: 1, removed: 0 },
        { path: "data.bin" },
        { path: "new name.txt", added: 1, removed: 0 },
        { path: "sub/b.txt", added: 0, removed: 1 },
      ]);
      // What it has staged stays as it is.
      assert.strictEqual(git(worktree.root, "status", "--porcelain"), before);
      assert.strictEqual(yield* worktrees.original(worktree, "a.txt"), "one\n");
      assert.strictEqual(yield* worktrees.original(worktree, "sub/b.txt"), "two\n");
      assert.isNull(yield* worktrees.original(worktree, "new name.txt"));
    }).pipe(Effect.provide(layer)),
  );

  it("reads git's list of changed files", () => {
    assert.deepStrictEqual(parseNumstat("1\t2\ta b.txt\0-\t-\tpic.png\0"), [
      { path: "a b.txt", added: 1, removed: 2 },
      { path: "pic.png" },
    ]);
    assert.deepStrictEqual(parseNumstat(""), []);
  });

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

  it.effect("copies only the ignored files the patterns name, and leaves the worktree clean", () =>
    Effect.gen(function* () {
      const repo = makeRepo();
      fs.appendFileSync(path.join(repo, ".gitignore"), ".env\nnode_modules/\n");
      git(repo, "add", "--all");
      git(repo, "commit", "--quiet", "-m", "ignore");
      fs.writeFileSync(path.join(repo, ".env"), "SECRET=1\n");
      fs.mkdirSync(path.join(repo, "sub", "node_modules", "pkg"), { recursive: true });
      fs.writeFileSync(path.join(repo, "sub", "node_modules", "pkg", "index.js"), "x\n");
      fs.symlinkSync("pkg/index.js", path.join(repo, "sub", "node_modules", "link.js"));
      fs.mkdirSync(path.join(repo, "ignored"));
      fs.writeFileSync(path.join(repo, "ignored", "unnamed.txt"), "x\n");
      fs.writeFileSync(path.join(repo, "untracked.txt"), "x\n");
      __test.setSetting("codeAcp.worktreeCopyFiles", [".env", "node_modules", "untracked.txt", "../outside"]);
      const { worktree } = yield* created(repo);
      const worktrees = yield* Worktrees;
      yield* worktrees.setup(worktree);
      assert.strictEqual(fs.readFileSync(path.join(worktree.root, ".env"), "utf8"), "SECRET=1\n");
      assert.isTrue(fs.existsSync(path.join(worktree.root, "sub", "node_modules", "pkg", "index.js")));
      assert.strictEqual(fs.readlinkSync(path.join(worktree.root, "sub", "node_modules", "link.js")), "pkg/index.js");
      assert.isFalse(fs.existsSync(path.join(worktree.root, "ignored")));
      assert.isFalse(fs.existsSync(path.join(worktree.root, "untracked.txt")));
      assert.deepStrictEqual(yield* worktrees.status(worktree), { changed: 0, commits: 0 });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("goes by the worktree's ignore rules, not an uncommitted change to the base's", () =>
    Effect.gen(function* () {
      const repo = makeRepo();
      fs.appendFileSync(path.join(repo, ".gitignore"), "local.txt\n");
      fs.writeFileSync(path.join(repo, "local.txt"), "x\n");
      __test.setSetting("codeAcp.worktreeCopyFiles", ["local.txt"]);
      const { worktree } = yield* created(repo);
      yield* (yield* Worktrees).setup(worktree);
      assert.isFalse(fs.existsSync(path.join(worktree.root, "local.txt")));
    }).pipe(Effect.provide(layer)),
  );

  it.effect("runs the setup command in a shell at the top of the worktree, even from a subfolder", () =>
    Effect.gen(function* () {
      const repo = makeRepo();
      __test.setSetting("codeAcp.worktreeSetupCommand", "pwd > where.txt && echo done >> where.txt");
      const { worktree } = yield* created(path.join(repo, "sub"));
      yield* (yield* Worktrees).setup(worktree);
      assert.strictEqual(fs.readFileSync(path.join(worktree.root, "where.txt"), "utf8"), `${worktree.root}\ndone\n`);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reports a failed command with its output, after copying what it could", () =>
    Effect.gen(function* () {
      const repo = makeRepo();
      fs.mkdirSync(path.join(repo, "ignored"));
      fs.writeFileSync(path.join(repo, "ignored", "f.txt"), "x\n");
      __test.setSetting("codeAcp.worktreeCopyFiles", ["ignored"]);
      __test.setSetting("codeAcp.worktreeSetupCommand", "echo oh no >&2; exit 3");
      const { worktree } = yield* created(repo);
      const err = yield* (yield* Worktrees).setup(worktree).pipe(Effect.flip);
      assert.include(err.message, "3");
      assert.include(err.message, "oh no");
      assert.isTrue(fs.existsSync(path.join(worktree.root, "ignored", "f.txt")));
    }).pipe(Effect.provide(layer)),
  );

  it.live("doesn't wait for a process the setup command leaves behind", () =>
    Effect.gen(function* () {
      const repo = makeRepo();
      __test.setSetting("codeAcp.worktreeSetupCommand", "sleep 30 & echo started");
      const { worktree } = yield* created(repo);
      const result = yield* (yield* Worktrees).setup(worktree).pipe(Effect.timeoutOption("10 seconds"));
      assert.isTrue(Option.isSome(result));
    }).pipe(Effect.provide(layer)),
  );

  it.live("stops the setup command when interrupted", () =>
    Effect.gen(function* () {
      const repo = makeRepo();
      __test.setSetting("codeAcp.worktreeSetupCommand", "sleep 30; touch finished.txt");
      const { worktree } = yield* created(repo);
      const result = yield* (yield* Worktrees)
        .setup(worktree)
        .pipe(Effect.timeoutOption("500 millis"), Effect.timeoutOption("10 seconds"));
      assert.deepStrictEqual(result, Option.some(Option.none()));
      assert.isFalse(fs.existsSync(path.join(worktree.root, "finished.txt")));
    }).pipe(Effect.provide(layer)),
  );

  it.effect("runs a project's command instead of the user's, only when allowed", () =>
    Effect.gen(function* () {
      const repo = makeRepo();
      __test.setSetting("codeAcp.worktreeSetupCommand", "touch user.txt");
      __test.setWorkspaceSetting(PROJECT_COMMAND, "touch project.txt");
      const worktrees = yield* Worktrees;
      const ran = (worktree: { root: string }) =>
        ["user.txt", "project.txt"].filter((file) => fs.existsSync(path.join(worktree.root, file)));

      const allowed = (yield* created(repo)).worktree;
      const asked: ProjectCommand[] = [];
      yield* worktrees.setup(allowed, (request) => Effect.sync(() => (asked.push(request), true)));
      assert.deepStrictEqual(ran(allowed), ["project.txt"]);
      assert.strictEqual(asked[0]?.command, "touch project.txt");

      const declined = (yield* created(repo)).worktree;
      yield* worktrees.setup(declined, () => Effect.succeed(false));
      assert.deepStrictEqual(ran(declined), ["user.txt"]);

      const nobodyAsked = (yield* created(repo)).worktree;
      yield* worktrees.setup(nobodyAsked);
      assert.deepStrictEqual(ran(nobodyAsked), ["user.txt"]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("doesn't ask about a project's command when there is none", () =>
    Effect.gen(function* () {
      const { worktree } = yield* created(makeRepo());
      yield* (yield* Worktrees).setup(worktree, () => Effect.die("asked"));
    }).pipe(Effect.provide(layer)),
  );

  it.effect("identifies a project's command by the command, its repository and the files it names", () =>
    Effect.gen(function* () {
      const repo = makeRepo();
      fs.appendFileSync(path.join(repo, ".gitignore"), "local.sh\n");
      fs.writeFileSync(path.join(repo, "setup.sh"), "echo one\n");
      git(repo, "add", "--all");
      git(repo, "commit", "--quiet", "-m", "script");
      const worktrees = yield* Worktrees;
      const fingerprint = (command: string, folder = repo) =>
        Effect.gen(function* () {
          __test.setWorkspaceSetting(PROJECT_COMMAND, command);
          const { worktree } = yield* created(folder);
          let seen = "";
          yield* worktrees.setup(worktree, (request) => Effect.sync(() => ((seen = request.fingerprint), false)));
          return seen;
        });

      const script = "sh ./setup.sh && echo done";
      const first = yield* fingerprint(script);
      assert.strictEqual(yield* fingerprint(script), first);
      assert.notStrictEqual(yield* fingerprint(`${script} again`), first);
      assert.notStrictEqual(yield* fingerprint(script, makeRepo()), first);

      fs.writeFileSync(path.join(repo, "setup.sh"), "echo two\n");
      git(repo, "commit", "--quiet", "--all", "-m", "change");
      assert.notStrictEqual(yield* fingerprint(script), first);

      // A script that reaches the worktree by being copied counts too.
      __test.setSetting("codeAcp.worktreeCopyFiles", ["local.sh"]);
      fs.writeFileSync(path.join(repo, "local.sh"), "echo one\n");
      const copied = yield* fingerprint("sh local.sh");
      fs.writeFileSync(path.join(repo, "local.sh"), "echo two\n");
      assert.notStrictEqual(yield* fingerprint("sh local.sh"), copied);
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
  const makeController = (reply?: string, askReply?: string) => {
    const asked: string[] = [];
    const posted: Array<Record<string, unknown>> = [];
    vscode.window.showWarningMessage = (async (message: string) => {
      asked.push(message);
      return reply;
    }) as never;
    const tabs = new TabList(undefined, () => "/w");
    const restarted: Array<string> = [];
    const stored = new Map<string, unknown>();
    const globalState = {
      keys: () => [...stored.keys()],
      get: (key: string) => stored.get(key),
      update: async (key: string, value: unknown) => void stored.set(key, value),
    } as vscode.Memento;
    const controller = new TabWorktrees({
      globalState: () => globalState,
      tabs: () => tabs,
      postTab: (_tab, message) => void posted.push(message),
      postTabs: () => {},
      status: () => {},
      confirmStartOver: () => Effect.succeed(true),
      startOver: () => Effect.void,
      restartSession: (tab) => Effect.sync(() => void restarted.push(tab.cwd)),
      ask: () => Effect.succeed(askReply),
    });
    return { asked, posted, restarted, tabs, controller, tab: tabs.active };
  };

  /** The agent's services only matter to `restartSession`, stubbed here. */
  const nameAfter = (controller: TabWorktrees, tab: Tab, text: string) =>
    controller.nameAfter(tab, text) as Effect.Effect<void, never, Worktrees>;

  it.effect("moves the folder of a tab alone in its worktree, and starts its session there", () =>
    Effect.gen(function* () {
      const { worktree, cwd } = yield* created(makeRepo());
      const { controller, tab, restarted } = makeController();
      tab.worktree = worktree;
      tab.cwd = cwd;
      yield* nameAfter(controller, tab, "fix it");
      assert.strictEqual(path.basename(tab.worktree.root), "fix-it");
      assert.strictEqual(tab.cwd, tab.worktree.root);
      assert.isTrue(fs.existsSync(tab.cwd));
      assert.deepStrictEqual(restarted, [tab.cwd]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("names the branch for every tab in the worktree, and doesn't stop the turn when git fails", () =>
    Effect.gen(function* () {
      const { worktree } = yield* created(makeRepo());
      const { controller, tab, tabs } = makeController();
      const fork = tabs.add("/w");
      const other = tabs.add("/w");
      tab.worktree = worktree;
      tab.branch = worktree.branch;
      fork.worktree = worktree;
      yield* nameAfter(controller, tab, "fix it");
      assert.strictEqual(tab.worktree.branch, "code-acp/fix-it");
      assert.strictEqual(tab.branch, "code-acp/fix-it");
      assert.strictEqual(fork.worktree.branch, "code-acp/fix-it");
      assert.isUndefined(other.worktree);

      const lost = {
        root: path.join(os.homedir(), ".code-acp", "worktrees", "gone", "abc123"),
        branch: "code-acp/abc123",
        base: path.join(scratch, "gone"),
      };
      tab.worktree = lost;
      yield* nameAfter(controller, tab, "fix it");
      assert.deepStrictEqual(tab.worktree, lost);
    }).pipe(Effect.provide(layer)),
  );

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

  it.effect("sets up the new worktree of a tab before its session, and a failure leaves the tab in it", () =>
    Effect.gen(function* () {
      const repo = makeRepo();
      workspace.workspaceFolders = [{ name: "repo", uri: Uri.file(repo) }];
      __test.setSetting("codeAcp.worktreeSetupCommand", "touch ready.txt; exit 1");
      const { controller, posted, tab } = makeController();
      tab.cwd = repo;
      tab.wantsWorktree = true;
      yield* controller.prepare(tab);
      workspace.workspaceFolders = undefined;
      assert.isDefined(tab.worktree);
      assert.isTrue(fs.existsSync(path.join(tab.worktree!.root, "ready.txt")));
      assert.isTrue(posted.some((message) => message.type === "error"));
    }).pipe(Effect.provide(layer)),
  );

  it.effect("sets up a worktree that came back, but not one that is still there", () =>
    Effect.gen(function* () {
      const repo = makeRepo();
      __test.setSetting("codeAcp.worktreeSetupCommand", "touch ready.txt");
      const { worktree, cwd } = yield* created(repo);
      const { controller, tab } = makeController();
      tab.worktree = worktree;
      tab.cwd = cwd;
      const ready = path.join(worktree.root, "ready.txt");
      yield* controller.ensure(tab);
      assert.isFalse(fs.existsSync(ready));
      fs.rmSync(worktree.root, { recursive: true });
      yield* controller.ensure(tab);
      assert.isTrue(fs.existsSync(ready));
    }).pipe(Effect.provide(layer)),
  );

  it.effect("asks before running a project's command, and again only when it changes", () =>
    Effect.gen(function* () {
      const repo = makeRepo();
      fs.writeFileSync(path.join(repo, "setup.sh"), "touch ran.txt\n");
      git(repo, "add", "--all");
      git(repo, "commit", "--quiet", "-m", "script");
      __test.setWorkspaceSetting(PROJECT_COMMAND, "sh setup.sh");
      const { asked, controller, tab } = makeController("Allow and Run");
      /** Prepares a new worktree for the tab, and returns whether the command ran in it. */
      const prepare = Effect.gen(function* () {
        workspace.workspaceFolders = [{ name: "repo", uri: Uri.file(repo) }];
        tab.worktree = undefined;
        tab.cwd = repo;
        tab.wantsWorktree = true;
        yield* controller.prepare(tab);
        workspace.workspaceFolders = undefined;
        return fs.existsSync(path.join(tab.worktree!.root, "ran.txt"));
      });

      assert.isTrue(yield* prepare);
      assert.lengthOf(asked, 1);
      assert.include(asked[0]!, "repo-");

      assert.isTrue(yield* prepare);
      assert.lengthOf(asked, 1);

      fs.writeFileSync(path.join(repo, "setup.sh"), "touch ran.txt; echo changed\n");
      git(repo, "commit", "--quiet", "--all", "-m", "change");
      assert.isTrue(yield* prepare);
      assert.lengthOf(asked, 2);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("runs nothing of the project's when the question is dismissed, and asks again next time", () =>
    Effect.gen(function* () {
      const repo = makeRepo();
      __test.setWorkspaceSetting(PROJECT_COMMAND, "touch ran.txt");
      const { asked, controller, tab } = makeController(undefined);
      for (const times of [1, 2]) {
        workspace.workspaceFolders = [{ name: "repo", uri: Uri.file(repo) }];
        tab.worktree = undefined;
        tab.cwd = repo;
        tab.wantsWorktree = true;
        yield* controller.prepare(tab);
        workspace.workspaceFolders = undefined;
        assert.isFalse(fs.existsSync(path.join(tab.worktree!.root, "ran.txt")));
        assert.lengthOf(asked, times);
      }
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

  describe("finishing", () => {
    const { showInformationMessage, showInputBox, showQuickPick } = vscode.window;
    const realPath = process.env.PATH;
    afterEach(() => {
      vscode.window.showInformationMessage = showInformationMessage;
      vscode.window.showInputBox = showInputBox;
      vscode.window.showQuickPick = showQuickPick;
      process.env.PATH = realPath;
    });

    /** What the host stands in for needs no services here: its `startOver` and `ask` are fakes. */
    const withoutHost = <A, E>(effect: Effect.Effect<A, E, any>) =>
      effect as Effect.Effect<A, E, Worktrees | ShadowGit>;

    /** Puts a `gh` on PATH that writes down how it was called and answers as told; `failCreate` makes `pr create` fail. */
    const fakeGh = (list = "[]", failCreate = false) => {
      const bin = path.join(scratch, `bin-${count++}`);
      fs.mkdirSync(bin);
      const log = path.join(bin, "log");
      fs.writeFileSync(
        path.join(bin, "gh"),
        `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
if [ "$2" = "list" ]; then printf '%s' '${list}'; exit 0; fi
cat >> '${log}'
${failCreate ? 'echo "no access" >&2; exit 1' : "echo https://example.test/pr/1"}
`,
        { mode: 0o755 },
      );
      process.env.PATH = `${bin}${path.delimiter}${realPath}`;
      return { read: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "") };
    };

    /** A repository tracking a bare remote, on `main`, and a worktree of it holding a commit. */
    const makeRemoteRepo = Effect.fnUntraced(function* () {
      const repo = makeRepo();
      const remote = path.join(scratch, `remote-${count++}.git`);
      execFileSync("git", ["init", "--quiet", "--bare", remote]);
      git(repo, "branch", "-M", "main");
      git(repo, "remote", "add", "origin", remote);
      git(repo, "push", "--quiet", "--set-upstream", "origin", "main");
      const { worktree, cwd } = yield* created(repo);
      fs.writeFileSync(path.join(worktree.root, "new.txt"), "x\n");
      git(worktree.root, "add", "--all");
      git(worktree.root, "commit", "--quiet", "-m", "add new");
      return { repo, remote, worktree, cwd };
    });

    it("reads a title and description from an agent's reply", () => {
      assert.deepStrictEqual(parsePrText("Fix it\n\nBecause.\n\n- one\n"), {
        title: "Fix it",
        body: "Because.\n\n- one",
      });
      assert.deepStrictEqual(parsePrText("```markdown\n# Fix it\n\nBecause.\n```"), {
        title: "Fix it",
        body: "Because.",
      });
      assert.deepStrictEqual(parsePrText("Only a title"), { title: "Only a title", body: "" });
      assert.isUndefined(parsePrText("  \n"));
    });

    it("makes a title and description from git when no agent wrote them", () => {
      assert.deepStrictEqual(fallbackPrText({ fork: "f", subjects: ["only one"], stat: " a | 1 +\n" }, "tab"), {
        title: "only one",
        body: "- only one\n\n```\n a | 1 +\n```",
      });
      assert.strictEqual(fallbackPrText({ fork: "f", subjects: ["a", "b"], stat: "" }, "tab").title, "tab");
      assert.strictEqual(fallbackPrText({ fork: "f", subjects: ["a", "b"], stat: "" }, "tab").body, "- a\n- b");
    });

    it.effect("merges the commits into the base folder, which leaves nothing to finish", () =>
      Effect.gen(function* () {
        const repo = makeRepo();
        const { worktree } = yield* created(repo);
        const worktrees = yield* Worktrees;
        fs.writeFileSync(path.join(worktree.root, "new.txt"), "x\n");
        yield* worktrees.commit(worktree, "add new");
        // Not a fast-forward: the base folder went on too.
        fs.writeFileSync(path.join(repo, "other.txt"), "y\n");
        git(repo, "add", "--all");
        git(repo, "commit", "--quiet", "-m", "other");
        assert.deepStrictEqual(yield* worktrees.merge(worktree), { conflicts: [] });
        assert.strictEqual(fs.readFileSync(path.join(repo, "new.txt"), "utf8"), "x\n");
        assert.include(git(repo, "log", "--format=%s"), "add new");
        assert.strictEqual(git(repo, "status", "--porcelain"), "");
        assert.deepStrictEqual(yield* worktrees.status(worktree), { changed: 0, commits: 0 });
      }).pipe(Effect.provide(layer)),
    );

    it.effect("leaves a merge with conflicts open, and can abort it", () =>
      Effect.gen(function* () {
        const repo = makeRepo();
        const { worktree } = yield* created(repo);
        const worktrees = yield* Worktrees;
        fs.writeFileSync(path.join(worktree.root, "a.txt"), "theirs\n");
        yield* worktrees.commit(worktree, "theirs");
        fs.writeFileSync(path.join(repo, "a.txt"), "ours\n");
        git(repo, "commit", "--quiet", "-am", "ours");
        assert.deepStrictEqual(yield* worktrees.merge(worktree), { conflicts: ["a.txt"] });
        assert.include(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), "<<<<<<<");
        yield* worktrees.abortMerge(worktree);
        assert.strictEqual(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), "ours\n");
        assert.strictEqual(git(repo, "status", "--porcelain"), "");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("won't merge over the base folder's own edits, but untracked files are no reason to stop", () =>
      Effect.gen(function* () {
        const repo = makeRepo();
        const { worktree } = yield* created(repo);
        const worktrees = yield* Worktrees;
        fs.writeFileSync(path.join(worktree.root, "new.txt"), "x\n");
        yield* worktrees.commit(worktree, "add new");
        fs.writeFileSync(path.join(repo, "untracked.txt"), "u\n");
        assert.isFalse(yield* worktrees.isBaseDirty(worktree));
        fs.writeFileSync(path.join(repo, "a.txt"), "edit\n");
        assert.isTrue(yield* worktrees.isBaseDirty(worktree));
        const error = yield* Effect.flip(worktrees.merge(worktree));
        assert.strictEqual(error._tag, "WorktreeError");
        assert.isFalse(fs.existsSync(path.join(repo, "new.txt")));
        assert.strictEqual(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), "edit\n");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("reports a merge git refuses, without conflicts to show for it", () =>
      Effect.gen(function* () {
        const repo = makeRepo();
        const { worktree } = yield* created(repo);
        const worktrees = yield* Worktrees;
        fs.writeFileSync(path.join(worktree.root, "new.txt"), "x\n");
        yield* worktrees.commit(worktree, "add new");
        fs.writeFileSync(path.join(repo, "new.txt"), "mine\n");
        const error = yield* Effect.flip(worktrees.merge(worktree));
        assert.include(error.message, "new.txt");
        assert.strictEqual(fs.readFileSync(path.join(repo, "new.txt"), "utf8"), "mine\n");
      }).pipe(Effect.provide(layer)),
    );

    const pickFinish = (kind: string) => {
      vscode.window.showQuickPick = (async (items: ReadonlyArray<{ choice?: { kind: string } }>) =>
        items.find((item) => item.choice?.kind === kind)) as never;
    };

    it.effect("merges after just the commit message, says so, and deletes the worktree after one question", () =>
      Effect.gen(function* () {
        const repo = makeRepo();
        const { worktree, cwd } = yield* created(repo);
        const { controller, tab, asked } = makeController("Delete Worktree");
        tab.worktree = worktree;
        tab.cwd = cwd;
        tab.used = true;
        fs.writeFileSync(path.join(worktree.root, "new.txt"), "x\n");
        vscode.window.showInputBox = (async () => "add new") as never;
        let title = "";
        vscode.window.showQuickPick = (async (
          items: ReadonlyArray<{ choice?: { kind: string } }>,
          options: { title: string },
        ) => {
          title = options.title;
          return items.find((item) => item.choice?.kind === "merge");
        }) as never;
        yield* withoutHost(controller.finish(tab));
        assert.include(title, `1 uncommitted file(s) · 0 commit(s) · ${worktree.branch}`);
        assert.deepStrictEqual(asked, []);
        assert.strictEqual(git(repo, "log", "-1", "--format=%s"), "add new\n");
        assert.isTrue(fs.existsSync(path.join(repo, "new.txt")));
        assert.strictEqual(tab.settled?.how, "merged");
        assert.isFalse(tab.finishable);
        assert.isTrue(fs.existsSync(worktree.root));

        yield* withoutHost(controller.deleteWorktree(tab));
        assert.lengthOf(asked, 1);
        assert.include(asked[0]!, "No work is lost");
        assert.include(asked[0]!, "conversation closes");
        assert.isFalse(fs.existsSync(worktree.root));
      }).pipe(Effect.provide(layer)),
    );

    it.effect("reads what a worktree holds when deleting: work added since it was merged isn't taken for gone", () =>
      Effect.gen(function* () {
        const repo = makeRepo();
        const { worktree, cwd } = yield* created(repo);
        const { controller, tab, asked } = makeController();
        tab.worktree = worktree;
        tab.cwd = cwd;
        fs.writeFileSync(path.join(worktree.root, "new.txt"), "x\n");
        yield* (yield* Worktrees).commit(worktree, "add new");
        pickFinish("merge");
        yield* withoutHost(controller.finish(tab));
        assert.strictEqual(tab.settled?.how, "merged");

        fs.writeFileSync(path.join(worktree.root, "more.txt"), "y\n");
        yield* withoutHost(controller.deleteWorktree(tab));
        assert.include(asked[0]!, "1 uncommitted file(s)");
        assert.isTrue(fs.existsSync(path.join(worktree.root, "more.txt")));

        yield* controller.refreshFinishable(tab);
        assert.isUndefined(tab.settled);
        assert.isTrue(tab.finishable);
      }).pipe(Effect.provide(layer)),
    );

    it.effect("keeps a merge with conflicts in the tab's state until it is solved outside the chat", () =>
      Effect.gen(function* () {
        const repo = makeRepo();
        const { worktree } = yield* created(repo);
        const { controller, tab } = makeController();
        tab.worktree = worktree;
        fs.writeFileSync(path.join(worktree.root, "a.txt"), "theirs\n");
        yield* (yield* Worktrees).commit(worktree, "theirs");
        fs.writeFileSync(path.join(repo, "a.txt"), "ours\n");
        git(repo, "commit", "--quiet", "-am", "ours");
        pickFinish("merge");
        yield* withoutHost(controller.finish(tab));
        assert.isDefined(tab.conflict);
        assert.isFalse(tab.finishable);

        // Not "the base folder is dirty": the bar has the way out.
        let picked = 0;
        vscode.window.showQuickPick = (async () => void picked++) as never;
        yield* withoutHost(controller.finish(tab));
        assert.strictEqual(picked, 0);
        yield* controller.refreshFinishable(tab);
        assert.isDefined(tab.conflict);

        fs.writeFileSync(path.join(repo, "a.txt"), "both\n");
        git(repo, "add", "--all");
        git(repo, "commit", "--quiet", "--no-edit");
        yield* controller.refreshFinishable(tab);
        assert.isUndefined(tab.conflict);
        assert.strictEqual(tab.settled?.how, "merged");
        assert.isFalse(tab.finishable);
      }).pipe(Effect.provide(layer)),
    );

    it.effect("gives up a merge with conflicts after asking, and doesn't try when it is over", () =>
      Effect.gen(function* () {
        const repo = makeRepo();
        const { worktree } = yield* created(repo);
        const { controller, tab, asked } = makeController("Abort Merge");
        tab.worktree = worktree;
        fs.writeFileSync(path.join(worktree.root, "a.txt"), "theirs\n");
        yield* (yield* Worktrees).commit(worktree, "theirs");
        fs.writeFileSync(path.join(repo, "a.txt"), "ours\n");
        git(repo, "commit", "--quiet", "-am", "ours");
        pickFinish("merge");
        yield* withoutHost(controller.finish(tab));
        asked.length = 0;

        yield* withoutHost(controller.abortMerge(tab));
        assert.lengthOf(asked, 1);
        assert.strictEqual(git(repo, "status", "--porcelain"), "");
        assert.isUndefined(tab.conflict);
        assert.isTrue(tab.finishable);

        yield* withoutHost(controller.abortMerge(tab));
        assert.lengthOf(asked, 1);
      }).pipe(Effect.provide(layer)),
    );

    it.effect("copies changes without asking twice, won't while an agent works, and closing then loses nothing", () =>
      Effect.gen(function* () {
        const repo = makeRepo();
        const { worktree } = yield* created(repo);
        const { controller, tab, asked } = makeController();
        tab.worktree = worktree;
        fs.writeFileSync(path.join(worktree.root, "new.txt"), "x\n");
        pickFinish("apply");
        const told: string[] = [];
        vscode.window.showInformationMessage = (async (message: string) => void told.push(message)) as never;

        tab.busy = true;
        yield* withoutHost(controller.finish(tab));
        assert.lengthOf(told, 1);
        assert.isFalse(fs.existsSync(path.join(repo, "new.txt")));
        tab.busy = false;

        yield* withoutHost(controller.finish(tab));
        assert.deepStrictEqual(asked, []);
        assert.include(git(repo, "status", "--porcelain"), "A  new.txt");
        assert.strictEqual(tab.settled?.how, "applied");
        yield* controller.refreshFinishable(tab);
        assert.isFalse(tab.finishable);
        assert.strictEqual(yield* controller.askRelease(tab), "delete");
        assert.deepStrictEqual(asked, []);

        // Editing a file that is already uncommitted is new work too.
        fs.writeFileSync(path.join(worktree.root, "new.txt"), "changed\n");
        yield* controller.refreshFinishable(tab);
        assert.isUndefined(tab.settled);
        assert.isTrue(tab.finishable);
      }).pipe(Effect.provide(layer)),
    );

    it.effect("says which of the base folder's own changes are in the way of copying", () =>
      Effect.gen(function* () {
        const repo = makeRepo();
        const { worktree } = yield* created(repo);
        const worktrees = yield* Worktrees;
        fs.writeFileSync(path.join(worktree.root, "a.txt"), "theirs\n");
        fs.writeFileSync(path.join(repo, "a.txt"), "mine\n");
        const error = yield* Effect.flip(worktrees.apply(worktree));
        assert.include(error.message, "own uncommitted changes to: a.txt");
        assert.strictEqual(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), "mine\n");
        // Changes to other files are no reason to stop.
        git(repo, "checkout", "--", "a.txt");
        fs.writeFileSync(path.join(repo, "other.txt"), "mine\n");
        assert.deepStrictEqual(yield* worktrees.apply(worktree), { applied: true, conflicts: [] });
      }).pipe(Effect.provide(layer)),
    );

    it.effect("keeps the ways to finish a worktree out of the picker of where the tab works", () =>
      Effect.gen(function* () {
        const repo = makeRepo();
        const { worktree } = yield* created(repo);
        const { controller, tab } = makeController();
        tab.worktree = worktree;
        let kinds: Array<string | undefined> = [];
        vscode.window.showQuickPick = (async (items: ReadonlyArray<{ choice?: { kind: string } }>) => {
          kinds = items.map((item) => item.choice?.kind);
          return undefined;
        }) as never;
        yield* withoutHost(controller.pick(tab));
        for (const kind of ["merge", "pr", "apply"]) {
          assert.notInclude(kinds, kind);
        }
        assert.includeMembers(kinds, ["local", "new", "window", "terminal", "delete"]);
      }).pipe(Effect.provide(layer)),
    );

    it.effect("deletes the tab's worktree from the picker, after asking when it holds work", () =>
      Effect.gen(function* () {
        const repo = makeRepo();
        const { worktree, cwd } = yield* created(repo);
        const { controller, tab, asked } = makeController("Delete Worktree");
        tab.worktree = worktree;
        tab.cwd = cwd;
        fs.writeFileSync(path.join(worktree.root, "new.txt"), "x\n");
        pickFinish("delete");
        yield* withoutHost(controller.pick(tab));
        assert.lengthOf(asked, 1);
        assert.include(asked[0]!, "1 uncommitted file(s)");
        assert.isFalse(fs.existsSync(worktree.root));
      }).pipe(Effect.provide(layer)),
    );

    it.effect("offers no way to the checkout a tab is in, and has a new worktree wait for the message there", () =>
      Effect.gen(function* () {
        const repo = makeRepo();
        const { controller, tab } = makeController();
        tab.cwd = repo;
        workspace.workspaceFolders = [{ name: "repo", uri: Uri.file(repo) }];
        let kinds: Array<string | undefined> = [];
        vscode.window.showQuickPick = (async (items: ReadonlyArray<{ choice?: { kind: string } }>) => {
          kinds = items.map((item) => item.choice?.kind);
          return items.find((item) => item.choice?.kind === "new");
        }) as never;
        yield* withoutHost(controller.pick(tab));
        assert.notInclude(kinds, "local");
        assert.notInclude(kinds, "current");
        assert.isTrue(tab.worktreeOnSend);
        assert.isUndefined(tab.worktree);
        assert.strictEqual(git(repo, "worktree", "list").trim().split("\n").length, 1);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            workspace.workspaceFolders = undefined;
          }),
        ),
        Effect.provide(layer),
      ),
    );

    it.effect("doesn't ask or commit when the base folder is dirty, or while an agent works in the worktree", () =>
      Effect.gen(function* () {
        const repo = makeRepo();
        const { worktree } = yield* created(repo);
        const { controller, tab, asked } = makeController("Merge");
        tab.worktree = worktree;
        fs.writeFileSync(path.join(worktree.root, "new.txt"), "x\n");
        vscode.window.showQuickPick = (async (items: ReadonlyArray<{ choice?: { kind: string } }>) =>
          items.find((item) => item.choice?.kind === "merge")) as never;
        const told: string[] = [];
        vscode.window.showInformationMessage = (async (message: string) => void told.push(message)) as never;

        tab.busy = true;
        yield* withoutHost(controller.finish(tab));
        assert.lengthOf(told, 1);
        tab.busy = false;

        fs.writeFileSync(path.join(repo, "a.txt"), "edit\n");
        yield* withoutHost(controller.finish(tab));
        assert.lengthOf(asked, 1);
        assert.include(asked[0]!, "uncommitted changes");
        assert.notInclude(git(worktree.root, "log", "--format=%s"), "new");
        assert.include(git(worktree.root, "status", "--porcelain"), "new.txt");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("doesn't commit when the user backs out of the commit message", () =>
      Effect.gen(function* () {
        const repo = makeRepo();
        const { worktree } = yield* created(repo);
        const { controller, tab } = makeController("Merge");
        tab.worktree = worktree;
        fs.writeFileSync(path.join(worktree.root, "new.txt"), "x\n");
        vscode.window.showInputBox = (async () => undefined) as never;
        vscode.window.showQuickPick = (async (items: ReadonlyArray<{ choice?: { kind: string } }>) =>
          items.find((item) => item.choice?.kind === "merge")) as never;
        yield* withoutHost(controller.finish(tab));
        assert.isFalse(fs.existsSync(path.join(repo, "new.txt")));
        assert.include(git(worktree.root, "status", "--porcelain"), "new.txt");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("offers no merge or pull request without a branch", () =>
      Effect.gen(function* () {
        const repo = makeRepo();
        const { worktree } = yield* created(repo);
        const { controller, tab } = makeController();
        tab.worktree = { root: worktree.root, base: worktree.base };
        let kinds: Array<string | undefined> = [];
        vscode.window.showQuickPick = (async (items: ReadonlyArray<{ choice?: { kind: string } }>) => {
          kinds = items.map((item) => item.choice?.kind);
          return undefined;
        }) as never;
        yield* withoutHost(controller.finish(tab));
        assert.deepStrictEqual(kinds, ["apply", "delete"]);
      }).pipe(Effect.provide(layer)),
    );

    it.effect("drafts a pull request with the agent, and pushes nothing until the user agrees", () =>
      Effect.gen(function* () {
        const { remote, worktree, cwd } = yield* makeRemoteRepo();
        const gh = fakeGh();
        const { controller, tab, posted } = makeController(undefined, "Add new\n\nWhy it matters.");
        tab.worktree = worktree;
        tab.cwd = cwd;
        vscode.window.showQuickPick = (async (items: ReadonlyArray<{ choice?: { kind: string } }>) =>
          items.find((item) => item.choice?.kind === "pr")) as never;
        yield* withoutHost(controller.finish(tab));
        assert.deepInclude(posted, {
          type: "prDraft",
          draft: { title: "Add new", body: "Why it matters.", head: worktree.branch, remote: "origin", base: "main" },
        });
        assert.strictEqual(git(remote, "branch", "--list", worktree.branch!), "");
        assert.notInclude(gh.read(), "pr create");

        yield* controller.createPr(tab, "Better title", "Better body");
        assert.notStrictEqual(git(remote, "branch", "--list", worktree.branch!), "");
        assert.include(gh.read(), `pr create --head ${worktree.branch} --title Better title --body-file - --base main`);
        assert.include(gh.read(), "Better body");
        assert.deepInclude(posted, { type: "prDraft" });
        assert.strictEqual(tab.settled?.how, "pr");
        assert.strictEqual(tab.settled?.target, "https://example.test/pr/1");
        // The worktree stays: a review may ask for more.
        assert.isTrue(fs.existsSync(worktree.root));
        yield* controller.refreshFinishable(tab);
        assert.isFalse(tab.finishable);
        // More work goes to the same pull request, which the bar keeps showing.
        fs.writeFileSync(path.join(worktree.root, "more.txt"), "y\n");
        yield* controller.refreshFinishable(tab);
        assert.isTrue(tab.finishable);
        assert.strictEqual(tab.settled?.how, "pr");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("makes the draft from the commits when the agent gives nothing", () =>
      Effect.gen(function* () {
        const { worktree } = yield* makeRemoteRepo();
        fakeGh();
        const { controller, tab, posted } = makeController();
        tab.worktree = worktree;
        vscode.window.showQuickPick = (async (items: ReadonlyArray<{ choice?: { kind: string } }>) =>
          items.find((item) => item.choice?.kind === "pr")) as never;
        yield* withoutHost(controller.finish(tab));
        const draft = posted.find((message) => message.type === "prDraft")?.draft as { title: string; body: string };
        assert.strictEqual(draft.title, "add new");
        assert.include(draft.body, "- add new");
        assert.include(draft.body, "new.txt");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("keeps the draft for another try when opening the pull request fails", () =>
      Effect.gen(function* () {
        const { worktree } = yield* makeRemoteRepo();
        fakeGh("[]", true);
        const { controller, tab, posted } = makeController(undefined, "Title");
        tab.worktree = worktree;
        vscode.window.showQuickPick = (async (items: ReadonlyArray<{ choice?: { kind: string } }>) =>
          items.find((item) => item.choice?.kind === "pr")) as never;
        yield* withoutHost(controller.finish(tab));
        const error = yield* Effect.flip(controller.createPr(tab, "Title", ""));
        assert.include(error.message, "no access");
        assert.deepStrictEqual(posted.at(-1), { type: "prPending", pending: false });
        assert.isUndefined(posted.find((message) => message.type === "prDraft" && message.draft === undefined));
      }).pipe(Effect.provide(layer)),
    );

    it.effect("pushes to the pull request that is already open, without a new draft", () =>
      Effect.gen(function* () {
        const { remote, worktree } = yield* makeRemoteRepo();
        const gh = fakeGh(`[{"url":"https://example.test/pr/7","state":"OPEN","headRefOid":"older"}]`);
        const { controller, tab, posted, asked } = makeController("Push");
        tab.worktree = worktree;
        vscode.window.showQuickPick = (async (items: ReadonlyArray<{ choice?: { kind: string } }>) =>
          items.find((item) => item.choice?.kind === "pr")) as never;
        yield* withoutHost(controller.finish(tab));
        assert.include(asked[0]!, "https://example.test/pr/7");
        assert.notStrictEqual(git(remote, "branch", "--list", worktree.branch!), "");
        assert.notInclude(gh.read(), "pr create");
        assert.isUndefined(posted.find((message) => message.type === "prDraft"));
        assert.strictEqual(tab.settled?.target, "https://example.test/pr/7");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("doesn't push to an open pull request that has it all, or draft another for one that was merged", () =>
      Effect.gen(function* () {
        const { remote, worktree } = yield* makeRemoteRepo();
        const head = git(worktree.root, "rev-parse", "HEAD").trim();
        fakeGh(`[{"url":"https://example.test/pr/7","state":"OPEN","headRefOid":"${head}"}]`);
        const { controller, tab, posted, asked } = makeController();
        tab.worktree = worktree;
        pickFinish("pr");
        yield* withoutHost(controller.finish(tab));
        assert.deepStrictEqual(asked, []);
        assert.strictEqual(git(remote, "branch", "--list", worktree.branch!), "");
        assert.strictEqual(tab.settled?.how, "pr");

        // Squashed on the website: the branch still has its commits.
        fakeGh(`[{"url":"https://example.test/pr/7","state":"MERGED","headRefOid":"${head}"}]`);
        yield* withoutHost(controller.refreshOnFocus(tab));
        assert.strictEqual(tab.settled?.how, "prMerged");
        assert.isUndefined(posted.find((message) => message.type === "prDraft"));
        yield* controller.refreshFinishable(tab);
        assert.isFalse(tab.finishable);
        assert.strictEqual(yield* controller.askRelease(tab), "delete");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("says what is missing for a pull request: a remote, or gh", () =>
      Effect.gen(function* () {
        const { worktree } = yield* created(makeRepo());
        const worktrees = yield* Worktrees;
        assert.include((yield* Effect.flip(worktrees.prTarget(worktree))).message, "no remote");

        const { worktree: pushable } = yield* makeRemoteRepo();
        const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
        const bin = path.join(scratch, `bin-${count++}`);
        fs.mkdirSync(bin);
        // A PATH with git on it and no gh; git itself gets the real one.
        fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh\nPATH='${realPath}' exec '${realGit}' "$@"\n`, {
          mode: 0o755,
        });
        process.env.PATH = bin;
        assert.include((yield* Effect.flip(worktrees.prTarget(pushable))).message, "GitHub CLI");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("cleans up worktrees no tab runs in, picking those with nothing to lose, and asks about the rest", () =>
      Effect.gen(function* () {
        const repo = makeRepo();
        const empty = yield* created(repo);
        const holding = yield* created(repo);
        const open = yield* created(repo);
        const own = path.join(scratch, `own-${count++}`);
        git(repo, "worktree", "add", "--quiet", "-b", `mine-${count}`, own);
        fs.writeFileSync(path.join(holding.worktree.root, "new.txt"), "x\n");
        workspace.workspaceFolders = [{ name: "repo", uri: Uri.file(repo) }];
        const { controller, tab, asked } = makeController();
        tab.worktree = open.worktree;

        let offered: ReadonlyArray<{ detail: string; picked: boolean }> = [];
        vscode.window.showQuickPick = (async (items: ReadonlyArray<{ detail: string; picked: boolean }>) => {
          offered = items;
          return items.filter((item) => item.picked);
        }) as never;
        const told: string[] = [];
        vscode.window.showInformationMessage = (async (message: string) => void told.push(message)) as never;
        yield* controller.cleanUp();
        assert.sameMembers(
          offered.map((item) => item.detail),
          [empty.worktree.root, holding.worktree.root],
        );
        assert.deepStrictEqual(
          offered.filter((item) => item.picked).map((item) => item.detail),
          [empty.worktree.root],
        );
        assert.deepStrictEqual(asked, []);
        assert.isFalse(fs.existsSync(empty.worktree.root));
        assert.isTrue(fs.existsSync(holding.worktree.root));
        assert.isTrue(fs.existsSync(open.worktree.root));
        assert.isTrue(fs.existsSync(own));
        assert.include(told.at(-1)!, "1 worktree");

        // Work that would be lost needs a yes.
        vscode.window.showQuickPick = (async (items: ReadonlyArray<unknown>) => [...items]) as never;
        yield* controller.cleanUp();
        assert.lengthOf(asked, 1);
        assert.isTrue(fs.existsSync(holding.worktree.root));
        workspace.workspaceFolders = undefined;
      }).pipe(Effect.provide(layer)),
    );

    it.effect("knows when a worktree holds something to finish", () =>
      Effect.gen(function* () {
        const { worktree } = yield* created(makeRepo());
        const { controller, tab } = makeController();
        tab.worktree = worktree;
        yield* controller.refreshFinishable(tab);
        assert.isFalse(tab.finishable);
        fs.writeFileSync(path.join(worktree.root, "new.txt"), "x\n");
        tab.busy = true;
        yield* controller.refreshFinishable(tab);
        assert.isFalse(tab.finishable);
        tab.busy = false;
        yield* controller.refreshFinishable(tab);
        assert.isTrue(tab.finishable);
      }).pipe(Effect.provide(layer)),
    );
  });
});
