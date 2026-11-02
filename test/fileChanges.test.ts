import { assert, describe, it } from "@effect/vitest";
import * as NodeChildProcessSpawner from "@effect/platform-node-shared/NodeChildProcessSpawner";
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import * as NodePath from "@effect/platform-node-shared/NodePath";
import { Effect, FileSystem, Layer } from "effect";
import * as os from "node:os";
import * as path from "node:path";
import { ShadowGit } from "../src/checkpoints";
import { beginTurn, ChangeSet, hunksOf, keepHunk, refresh } from "../src/fileChanges";
import { ExtensionCtx } from "../src/runtime";
import { changeBlocks, keepBlock, replacement, undoBlock } from "../src/ui/lineDiff";
import { makeExtensionCtx } from "./helpers";

const checkpoint = (turn: number, message: number | undefined) => ({ turn, tree: `t${turn}`, label: "", at: 0, message });

describe("checkpoints across a reload", () => {
  it("moves checkpoints onto the turns of their replayed messages", () => {
    const changes = ChangeSet.fromSaved({ root: "/w", checkpoints: [checkpoint(1, 0), checkpoint(3, 2)], messages: 3 });
    changes.matchReplay([10, 11, 12]);
    assert.deepStrictEqual(
      changes.checkpoints.map((c) => [c.turn, c.message]),
      [
        [10, 0],
        [12, 2],
      ],
    );
    assert.strictEqual(changes.countMessage(), 3);
    assert.strictEqual(changes.messages, 4);
  });

  it("drops the positions when the history doesn't line up", () => {
    const changes = ChangeSet.fromSaved({ root: "/w", checkpoints: [checkpoint(1, 0)], messages: 2 });
    changes.matchReplay([10, 11, 12]);
    assert.deepStrictEqual(
      changes.checkpoints.map((c) => [c.turn, c.message]),
      [[1, undefined]],
    );
    // Counting starts over from the replayed history.
    assert.strictEqual(changes.countMessage(), 3);
  });

  it("doesn't count messages saved before they were counted", () => {
    const changes = ChangeSet.fromSaved({ root: "/w", checkpoints: [checkpoint(1, undefined)] });
    assert.isUndefined(changes.countMessage());
    changes.matchReplay([10]);
    assert.deepStrictEqual(changes.checkpoints[0]!.turn, 1);
    assert.strictEqual(changes.countMessage(), 1);
  });
});

describe("reviewing changes one by one", () => {
  const before = "one\ntwo\nthree\nfour\nfive\nsix\n";
  const after = "one\nTWO\nthree\nfour\nfive\nsix\nseven\n";

  it("splits a file into blocks of changed lines", () => {
    assert.deepStrictEqual(changeBlocks(before, after), [
      { oldStart: 1, newStart: 1, removed: ["two"], added: ["TWO"] },
      { oldStart: 6, newStart: 6, removed: [], added: ["seven"] },
    ]);
  });

  it("keeps or undoes one block and leaves the other", () => {
    const [first, second] = changeBlocks(before, after);
    assert.strictEqual(keepBlock(before, first!), "one\nTWO\nthree\nfour\nfive\nsix\n");
    assert.strictEqual(undoBlock(after, first!), "one\ntwo\nthree\nfour\nfive\nsix\nseven\n");
    assert.strictEqual(undoBlock(after, second!), "one\nTWO\nthree\nfour\nfive\nsix\n");
    assert.deepStrictEqual(changeBlocks(keepBlock(before, first!), after), [{ ...second!, oldStart: 6 }]);
  });

  it("gives back the exact text at the end of a file and with CRLF", () => {
    for (const [a, b] of [
      ["a", "a\n"],
      ["a\n", "a"],
      ["a\nb", "a"],
      ["a", "a\nb"],
      ["", "x\n"],
      ["x\n", ""],
      ["a\r\nb\r\n", "a\r\nc\r\nb\r\n"],
    ] as const) {
      const blocks = changeBlocks(a, b);
      assert.isAbove(blocks.length, 0);
      assert.strictEqual(blocks.reduceRight<string>((text, block) => undoBlock(text, block), b), a);
      assert.strictEqual(blocks.reduceRight<string>((text, block) => keepBlock(text, block), a), b);
    }
  });

  it("finds the smallest edit, without splitting a character", () => {
    const apply = (text: string, next: string) => {
      const { start, end, insert } = replacement(text, next);
      return { edit: text.slice(start, end), insert, result: text.slice(0, start) + insert + text.slice(end) };
    };
    assert.deepStrictEqual(apply("a\nb\nc\n", "a\nc\n"), { edit: "b\n", insert: "", result: "a\nc\n" });
    assert.deepStrictEqual(apply("a\r\nb\r\n", "a\nb\r\n"), { edit: "\r\n", insert: "\n", result: "a\nb\r\n" });
    assert.deepStrictEqual(apply("😀", "😁"), { edit: "😀", insert: "😁", result: "😁" });
    assert.strictEqual(apply("same", "same").edit, "");
  });

  const inRepo = <A, E>(body: (root: string, file: string) => Effect.Effect<A, E, ShadowGit | FileSystem.FileSystem>) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      return yield* body(root, path.join(root, "file.txt")).pipe(Effect.provide(ShadowGit.layer));
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.provideMerge(
          Layer.mergeAll(NodeChildProcessSpawner.layer, Layer.succeed(ExtensionCtx, makeExtensionCtx(path.join(os.tmpdir(), `code-acp-hunks-${process.pid}`)))),
          Layer.mergeAll(NodeFileSystem.layer, NodePath.layer),
        ),
      ),
    );

  it.live("keeps one change: the others stay listed", () =>
    inRepo((root, file) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(file, before);
        const changes = new ChangeSet();
        yield* beginTurn(changes, root, 1, "edit", 0);
        yield* fs.writeFileString(file, after);
        yield* refresh(changes);
        assert.deepStrictEqual(changes.files.map((f) => [f.added, f.removed]), [[2, 1]]);

        const [first, second] = yield* hunksOf(changes, file, after);
        assert.isTrue(yield* keepHunk(changes, file, first!));
        yield* refresh(changes);
        assert.deepStrictEqual(changes.files.map((f) => [f.added, f.removed]), [[1, 0]]);
        assert.strictEqual(yield* fs.readFileString(file), after);

        // The change kept is gone, so it can't be kept twice.
        assert.isFalse(yield* keepHunk(changes, file, first!));

        assert.isTrue(yield* keepHunk(changes, file, second!));
        yield* refresh(changes);
        assert.deepStrictEqual(changes.files, []);
      }),
    ),
  );

  it.live("reviews created files as whole files", () =>
    inRepo((root, file) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(path.join(root, "seed.txt"), "seed\n");
        const changes = new ChangeSet();
        yield* beginTurn(changes, root, 1, "edit", 0);
        yield* fs.writeFileString(file, "new\n");
        yield* refresh(changes);
        assert.deepStrictEqual(yield* hunksOf(changes, file, "new\n"), []);
      }),
    ),
  );
});
