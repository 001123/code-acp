import type * as acp from "@agentclientprotocol/sdk";
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach } from "vitest";
import type * as vscode from "vscode";
import { AutoApprove, pathsAreSafe, verdictOf, type ApprovalContext } from "../src/chat/autoApprove";
import { ExtensionCtx } from "../src/runtime";
import { __test } from "./stubs/vscode";

const memento = (values = new Map<string, unknown>()) =>
  ({
    get: (key: string) => values.get(key),
    update: async (key: string, value: unknown) =>
      void (value === undefined ? values.delete(key) : values.set(key, value)),
  }) as unknown as vscode.Memento;

const layer = () =>
  AutoApprove.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ExtensionCtx, { workspaceState: memento() } as unknown as vscode.ExtensionContext),
        NodeFileSystem.layer,
      ),
    ),
  );

const tempFolder = Effect.acquireRelease(
  Effect.promise(async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "code-acp-approve-")));
    await fs.mkdir(path.join(root, "work"));
    await fs.writeFile(path.join(root, "work", "a.ts"), "");
    await fs.writeFile(path.join(root, "secret"), "");
    return root;
  }),
  (root) => Effect.promise(() => fs.rm(root, { recursive: true, force: true })),
);

const ALLOW: acp.PermissionOption = { optionId: "once", name: "Allow", kind: "allow_once" };
const ALWAYS: acp.PermissionOption = { optionId: "always", name: "Always", kind: "allow_always" };

const request = (
  toolCall: Partial<acp.ToolCallUpdate>,
  options: acp.PermissionOption[] = [ALWAYS, ALLOW],
): acp.RequestPermissionRequest => ({ sessionId: "s", toolCall: { toolCallId: "t", ...toolCall }, options });

const answer = (req: acp.RequestPermissionRequest, context: Partial<ApprovalContext> & { cwd: string }) =>
  AutoApprove.use((rules) => rules.approval(req, { inWorktree: false, known: undefined, ...context })).pipe(
    Effect.map(Option.map((approval) => approval.optionId)),
    Effect.map(Option.getOrUndefined),
  );

beforeEach(() => __test.reset());

describe("verdictOf", () => {
  const all = { read: "allow", edit: "allow", execute: "allow", fetch: "allow" } as const;

  it("asks when no rule allows it", () => {
    for (const kind of ["read", "search", "edit", "move", "execute", "fetch"] as const) {
      assert.strictEqual(verdictOf({}, kind, false), "ask");
      assert.strictEqual(
        verdictOf({ [kind === "search" ? "read" : kind === "move" ? "edit" : kind]: "ask" }, kind, false),
        "ask",
      );
    }
  });

  it("checks the paths of reads and edits, and takes the rule's word for the rest", () => {
    assert.strictEqual(verdictOf(all, "read", false), "ifPathsSafe");
    assert.strictEqual(verdictOf(all, "search", false), "ifPathsSafe");
    assert.strictEqual(verdictOf(all, "edit", false), "ifPathsSafe");
    assert.strictEqual(verdictOf(all, "move", false), "ifPathsSafe");
    assert.strictEqual(verdictOf(all, "execute", false), "allow");
    assert.strictEqual(verdictOf(all, "fetch", false), "allow");
  });

  it("always asks about what no rule covers", () => {
    for (const kind of ["other", "switch_mode", "delete", "think", null, undefined] as const) {
      assert.strictEqual(verdictOf(all, kind, false), "ask");
    }
  });

  it("allows the worktree rule only in worktree tabs, and never for what it can't tell or that leaves plan mode", () => {
    const rules = { worktreeTabs: "allow" } as const;
    for (const kind of ["read", "search", "edit", "move", "delete", "execute", "fetch"] as const) {
      assert.strictEqual(verdictOf(rules, kind, true), "allow");
      assert.strictEqual(verdictOf(rules, kind, false), "ask");
    }
    for (const kind of ["other", "switch_mode", "think", undefined] as const) {
      assert.strictEqual(verdictOf(rules, kind, true), "ask");
    }
  });
});

describe("pathsAreSafe", () => {
  it("wants paths, all inside the folder", () => {
    assert.isFalse(pathsAreSafe("read", "/w", []));
    assert.isTrue(pathsAreSafe("read", "/w", ["/w", "/w/a.ts", "/w/..a/b"]));
    assert.isFalse(pathsAreSafe("read", "/w", ["/w/a.ts", "/x/b.ts"]));
    assert.isFalse(pathsAreSafe("read", "/w", ["/"]));
    assert.isFalse(pathsAreSafe("read", "/w", ["/w2/a.ts"]));
  });

  it("protects what can run later from being written, not from being read", () => {
    for (const target of [
      "/w/.git/hooks/pre-commit",
      "/w/.vscode/tasks.json",
      "/w/sub/.git/config",
      "/w/.GIT/config",
      "/w/.VSCode/tasks.json",
    ]) {
      assert.isFalse(pathsAreSafe("edit", "/w", [target]), target);
      assert.isFalse(pathsAreSafe("move", "/w", [target]), target);
      assert.isTrue(pathsAreSafe("read", "/w", [target]), target);
    }
    assert.isTrue(pathsAreSafe("edit", "/w", ["/w/.github/x.yml", "/w/.gitignore"]));
  });
});

describe("AutoApprove", () => {
  it.live("answers from what earlier updates said, with the option that keeps no rule in the agent", () =>
    Effect.gen(function* () {
      const root = yield* tempFolder;
      const cwd = path.join(root, "work");
      __test.setSetting("codeAcp.autoApprove", { read: "allow" });
      const known = { kind: "read", locations: [{ path: path.join(cwd, "a.ts") }], diffs: [] } as const;
      assert.strictEqual(yield* answer(request({}), { cwd, known }), "once");
      assert.isUndefined(yield* answer(request({}), { cwd }));
    }).pipe(Effect.scoped, Effect.provide(layer())),
  );

  it.live("asks when the agent offers no single approval", () =>
    Effect.gen(function* () {
      const root = yield* tempFolder;
      const cwd = path.join(root, "work");
      __test.setSetting("codeAcp.autoApprove", { execute: "allow" });
      assert.strictEqual(yield* answer(request({ kind: "execute" }), { cwd }), "once");
      assert.isUndefined(yield* answer(request({ kind: "execute" }, [ALWAYS]), { cwd }));
    }).pipe(Effect.scoped, Effect.provide(layer())),
  );

  it.live("checks every path, those of diffs too, and asks about relative ones", () =>
    Effect.gen(function* () {
      const root = yield* tempFolder;
      const cwd = path.join(root, "work");
      __test.setSetting("codeAcp.autoApprove", { edit: "allow" });
      const inside = path.join(cwd, "new", "deep", "file.ts");
      const outside = path.join(root, "secret");
      assert.strictEqual(yield* answer(request({ kind: "edit", locations: [{ path: inside }] }), { cwd }), "once");
      assert.isUndefined(yield* answer(request({ kind: "edit", locations: [{ path: outside }] }), { cwd }));
      assert.isUndefined(
        yield* answer(request({ kind: "edit", locations: [{ path: path.join(cwd, "..", "secret") }] }), { cwd }),
      );
      assert.isUndefined(yield* answer(request({ kind: "edit", locations: [{ path: "a.ts" }] }), { cwd }));
      assert.isUndefined(yield* answer(request({ kind: "edit" }), { cwd }));
      assert.isUndefined(
        yield* answer(
          request({
            kind: "edit",
            locations: [{ path: inside }],
            content: [{ type: "diff", path: outside, newText: "x" }],
          }),
          { cwd },
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(layer())),
  );

  it.live("follows links, however they lead out", () =>
    Effect.gen(function* () {
      const root = yield* tempFolder;
      const cwd = path.join(root, "work");
      yield* Effect.promise(async () => {
        await fs.symlink(path.join(root, "secret"), path.join(cwd, "to-file"));
        await fs.symlink(root, path.join(cwd, "to-folder"));
        await fs.symlink(path.join(root, "nothing"), path.join(cwd, "dangling"));
        await fs.mkdir(path.join(cwd, ".git", "hooks"), { recursive: true });
        await fs.symlink(path.join(cwd, ".git", "hooks"), path.join(cwd, "hooks"));
      });
      __test.setSetting("codeAcp.autoApprove", { read: "allow", edit: "allow" });
      const asks = (kind: acp.ToolKind, file: string) =>
        answer(request({ kind, locations: [{ path: path.join(cwd, file) }] }), { cwd });
      assert.isUndefined(yield* asks("read", "to-file"));
      assert.isUndefined(yield* asks("read", "to-folder/secret"));
      assert.isUndefined(yield* asks("edit", "to-folder/new.ts"));
      assert.isUndefined(yield* asks("edit", "dangling"));
      assert.isUndefined(yield* asks("edit", "hooks/pre-commit"));
      assert.strictEqual(yield* asks("read", "a.ts"), "once");
    }).pipe(Effect.scoped, Effect.provide(layer())),
  );

  it.live("works from a folder reached through a link", () =>
    Effect.gen(function* () {
      const root = yield* tempFolder;
      const cwd = path.join(root, "link-to-work");
      yield* Effect.promise(() => fs.symlink(path.join(root, "work"), cwd));
      __test.setSetting("codeAcp.autoApprove", { read: "allow" });
      assert.strictEqual(
        yield* answer(request({ kind: "read", locations: [{ path: path.join(root, "work", "a.ts") }] }), { cwd }),
        "once",
      );
    }).pipe(Effect.scoped, Effect.provide(layer())),
  );

  it.live("lets a workspace widen or narrow the user's rules, one by one", () =>
    Effect.gen(function* () {
      const root = yield* tempFolder;
      const cwd = path.join(root, "work");
      const rules = yield* AutoApprove;
      __test.setSetting("codeAcp.autoApprove", { execute: "allow" });
      assert.strictEqual(yield* answer(request({ kind: "execute" }), { cwd }), "once");
      assert.isUndefined(yield* answer(request({ kind: "fetch" }), { cwd }));

      yield* rules.setWorkspaceRules({ execute: "ask", fetch: "allow" });
      assert.isUndefined(yield* answer(request({ kind: "execute" }), { cwd }));
      assert.strictEqual(yield* answer(request({ kind: "fetch" }), { cwd }), "once");

      yield* rules.setWorkspaceRules({});
      assert.deepStrictEqual(yield* rules.workspaceRules, {});
      assert.strictEqual(yield* answer(request({ kind: "execute" }), { cwd }), "once");
    }).pipe(Effect.scoped, Effect.provide(layer())),
  );

  it.live("ignores values that make no sense, so everything asks", () =>
    Effect.gen(function* () {
      const root = yield* tempFolder;
      __test.setSetting("codeAcp.autoApprove", { execute: "yes please" });
      assert.isUndefined(yield* answer(request({ kind: "execute" }), { cwd: path.join(root, "work") }));
    }).pipe(Effect.scoped, Effect.provide(layer())),
  );
});
