import { Effect, Schema } from "effect";
import * as path from "node:path";
import * as vscode from "vscode";
import { CheckpointError, ShadowGit } from "./checkpoints";
import { t } from "./i18n";
import { thenable } from "./runtime";

/** A file changed since the user last reviewed the changes, as the chat lists it. */
export interface ChangedFile {
  path: string;
  /** Path relative to the workspace, for display. */
  name: string;
  added: number;
  removed: number;
  created: boolean;
  deleted: boolean;
  binary: boolean;
}

/** The work tree as it was before a turn. */
const Checkpoint = Schema.Struct({
  turn: Schema.Int,
  /** ShadowGit snapshot. */
  tree: Schema.String,
  /** Start of the user message, to pick the checkpoint by. */
  label: Schema.String,
  /** Epoch ms. */
  at: Schema.Finite,
  /** Position of its user message in the session's history, from 0, to find the message again when it replays. */
  message: Schema.optional(Schema.Int),
});
type Checkpoint = typeof Checkpoint.Type;

/** A tab's checkpoints as saved in workspaceState. */
export const SavedChanges = Schema.Struct({
  root: Schema.String,
  base: Schema.optional(Schema.String),
  checkpoints: Schema.Array(Checkpoint),
  reverted: Schema.optional(Schema.Array(Schema.String)),
  messages: Schema.optional(Schema.Int),
});
export type SavedChanges = typeof SavedChanges.Type;

/** Checkpoints kept per tab; older ones are dropped. */
const MAX_CHECKPOINTS = 100;

/** A first snapshot of a big work tree copies every file into the shadow repository. */
const SNAPSHOT_TIMEOUT_SECONDS = 60;

/** Characters of the user message kept as a checkpoint's label. */
const LABEL_LENGTH = 60;

/**
 * One tab's view of the files in its work tree, from ShadowGit snapshots: the changes since the user last kept
 * or undid them, and a checkpoint before each turn. Whoever changed a file (the agent's tools, a terminal,
 * the user) is not told apart.
 */
export class ChangeSet {
  /** The work tree; undefined until the first turn. */
  root?: string;
  /** Snapshot the changes are listed against: the start of the first turn, or the last review. */
  base?: string;
  checkpoints: Checkpoint[] = [];
  /** Files put back since the last turn, relative to `root`; the next prompt tells the agent. */
  readonly reverted = new Set<string>();
  /** Why snapshots are off for this tab, after one failed. */
  disabled?: string;
  /** Result of the last `refresh`. */
  files: ChangedFile[] = [];
  /** Turns whose checkpoint differs from the work tree, as of the last `refresh`. */
  turns: number[] = [];
  /** User messages in the session's history so far; undefined when not known (saved before it was counted). */
  messages?: number = 0;

  get saved(): SavedChanges | undefined {
    return this.root === undefined
      ? undefined
      : {
          root: this.root,
          base: this.base,
          checkpoints: this.checkpoints,
          reverted: [...this.reverted],
          messages: this.messages,
        };
  }

  static fromSaved(saved: SavedChanges | undefined): ChangeSet {
    const changes = new ChangeSet();
    if (saved) {
      changes.root = saved.root;
      changes.base = saved.base;
      changes.checkpoints = [...saved.checkpoints];
      changes.messages = saved.messages;
      for (const file of saved.reverted ?? []) {
        changes.reverted.add(file);
      }
    }
    return changes;
  }

  /** Forgets the checkpoints and changes; `messages` stays, as it counts the session's messages. */
  clear(): void {
    this.root = undefined;
    this.base = undefined;
    this.checkpoints = [];
    this.reverted.clear();
    this.disabled = undefined;
    this.files = [];
    this.turns = [];
  }

  /** `file` (absolute) relative to the work tree, as git names it; undefined when outside of it. */
  relative(file: string): string | undefined {
    if (this.root === undefined) {
      return undefined;
    }
    const rel = path.relative(this.root, file);
    return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel.split(path.sep).join("/") : undefined;
  }

  /**
   * A note for the agent on the files put back since its last turn, cleared once taken: it has to read them
   * again before editing them.
   */
  /** Counts a user message sent to the session; its position, when known. */
  countMessage(): number | undefined {
    const position = this.messages;
    this.messages = position === undefined ? undefined : position + 1;
    return position;
  }

  /**
   * After the session's history replayed with `turns` for its user messages, in order: moves each checkpoint onto
   * its message's turn. When the count differs from the one kept, the positions can't be trusted and are dropped.
   */
  matchReplay(turns: ReadonlyArray<number>): void {
    const matches = this.messages === turns.length;
    this.checkpoints = this.checkpoints.map((c) => {
      if (c.message === undefined) return c;
      const turn = matches ? turns[c.message] : undefined;
      return turn === undefined ? { ...c, message: undefined } : { ...c, turn };
    });
    this.messages = turns.length;
  }

  takeNote(): string | undefined {
    if (this.reverted.size === 0) {
      return undefined;
    }
    const files = [...this.reverted].sort();
    this.reverted.clear();
    return `[Note from the editor: since your last turn the user reverted these files to an earlier state, so they may differ from what you last saw or wrote. Read them again before changing them: ${files.join(", ")}]`;
  }
}

const snapshotOf = (root: string) =>
  ShadowGit.use((git) => git.snapshot(root)).pipe(
    Effect.timeoutOrElse({
      duration: `${SNAPSHOT_TIMEOUT_SECONDS} seconds`,
      orElse: () => Effect.fail(new CheckpointError({ message: t("checkpoints.timeout", SNAPSHOT_TIMEOUT_SECONDS) })),
    }),
  );

/** Takes the checkpoint before `turn`; the first one also starts the list of changes. */
export const beginTurn = Effect.fn("ChangeSet.beginTurn")(function* (
  changes: ChangeSet,
  root: string,
  turn: number,
  message: string,
  position: number | undefined,
) {
  if (changes.disabled) {
    return;
  }
  if (changes.root !== root) {
    changes.clear();
    changes.root = root;
  }
  const tree = yield* snapshotOf(root);
  changes.base ??= tree;
  const label = message.replace(/\s+/g, " ").trim();
  changes.checkpoints.push({
    turn,
    tree,
    label: label.length > LABEL_LENGTH ? `${label.slice(0, LABEL_LENGTH - 1)}…` : label,
    at: Date.now(),
    message: position,
  });
  changes.checkpoints.splice(0, Math.max(0, changes.checkpoints.length - MAX_CHECKPOINTS));
});

/** Lists the changes since `base` and the checkpoints that would change something; returns the snapshot taken. */
export const refresh = Effect.fn("ChangeSet.refresh")(function* (changes: ChangeSet) {
  const { root, base } = changes;
  if (root === undefined || base === undefined || changes.disabled) {
    changes.files = [];
    changes.turns = [];
    return undefined;
  }
  const current = yield* snapshotOf(root);
  const diff = yield* ShadowGit.use((git) => git.diff(root, base, current));
  changes.files = diff.map((change) => {
    const file = path.join(root, ...change.file.split("/"));
    return {
      path: file,
      name: vscode.workspace.asRelativePath(file),
      added: change.added,
      removed: change.removed,
      created: change.status === "added",
      deleted: change.status === "deleted",
      binary: change.binary,
    };
  });
  changes.turns = changes.checkpoints.filter((c) => c.tree !== current).map((c) => c.turn);
  return current;
});

/** What `file` held at the last review; undefined when it is not among the changes. */
export const beforeOf = Effect.fn("ChangeSet.beforeOf")(function* (changes: ChangeSet, file: string) {
  const rel = changes.relative(file);
  const { root, base } = changes;
  if (rel === undefined || root === undefined || base === undefined || !changes.files.some((f) => f.path === file)) {
    return undefined;
  }
  return yield* ShadowGit.use((git) => git.show(root, base, rel));
});

/** Accepts the changes to `file`, or to every file: they are no longer listed. */
export const keep = Effect.fn("ChangeSet.keep")(function* (changes: ChangeSet, file: string | undefined) {
  const { root, base } = changes;
  if (root === undefined || base === undefined) {
    return;
  }
  const current = yield* snapshotOf(root);
  const rel = file === undefined ? undefined : changes.relative(file);
  if (file === undefined) {
    changes.base = current;
  } else if (rel !== undefined) {
    changes.base = yield* ShadowGit.use((git) => git.merge(root, base, current, [rel]));
  }
});

/** Puts `file`, or every changed file, back as it was at the last review; returns the files put back. */
export const undo = Effect.fn("ChangeSet.undo")(function* (changes: ChangeSet, file: string | undefined) {
  const { root, base } = changes;
  if (root === undefined || base === undefined) {
    return [];
  }
  const current = yield* snapshotOf(root);
  const all = (yield* ShadowGit.use((git) => git.diff(root, base, current))).map((c) => c.file);
  const rel = file === undefined ? undefined : changes.relative(file);
  const files = file === undefined ? all : all.filter((each) => each === rel);
  if (files.length > 0) {
    yield* ShadowGit.use((git) => git.restore(root, base, files));
    for (const each of files) {
      changes.reverted.add(each);
    }
  }
  return files;
});

/** Checkpoints that would change something, newest first, with the files restoring each would put back. */
export const restorable = Effect.fn("ChangeSet.restorable")(function* (changes: ChangeSet) {
  const { root } = changes;
  if (root === undefined) {
    return [];
  }
  const current = yield* snapshotOf(root);
  const out: Array<{ checkpoint: Checkpoint; files: number }> = [];
  for (const checkpoint of [...changes.checkpoints].reverse()) {
    if (checkpoint.tree === current) {
      continue;
    }
    const diff = yield* ShadowGit.use((git) => git.diff(root, checkpoint.tree, current));
    if (diff.length > 0) {
      out.push({ checkpoint, files: diff.length });
    }
  }
  return out;
});

/** Files restoring the checkpoint of `turn` would put back. */
export const restorePlan = Effect.fn("ChangeSet.restorePlan")(function* (changes: ChangeSet, turn: number) {
  const { root } = changes;
  const checkpoint = changes.checkpoints.find((c) => c.turn === turn);
  if (root === undefined || !checkpoint) {
    return [];
  }
  const current = yield* snapshotOf(root);
  return (yield* ShadowGit.use((git) => git.diff(root, checkpoint.tree, current))).map((c) => c.file);
});

/** Puts the work tree back as it was before `turn`; that checkpoint and the later ones are dropped. */
export const restore = Effect.fn("ChangeSet.restore")(function* (changes: ChangeSet, turn: number) {
  const { root } = changes;
  const checkpoint = changes.checkpoints.find((c) => c.turn === turn);
  if (root === undefined || !checkpoint) {
    return [];
  }
  const files = yield* restorePlan(changes, turn);
  if (files.length > 0) {
    yield* ShadowGit.use((git) => git.restore(root, checkpoint.tree, files));
    for (const each of files) {
      changes.reverted.add(each);
    }
  }
  changes.checkpoints = changes.checkpoints.filter((c) => c.turn < turn);
  return files;
});

/** Writes `content` to `file`, through its editor buffer when open; null deletes the file. */
export const writeFile = Effect.fn("writeFile")(function* (file: string, content: string | null) {
  const uri = vscode.Uri.file(file);
  const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath && !d.isClosed);
  if (content === null) {
    yield* thenable(() => vscode.workspace.fs.delete(uri, { useTrash: true })).pipe(
      Effect.catchIf(
        (err) => err.cause instanceof vscode.FileSystemError && err.cause.code === "FileNotFound",
        () => Effect.void,
      ),
    );
    return;
  }
  if (open) {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(0, 0, open.lineCount, 0), content);
    yield* thenable(() => vscode.workspace.applyEdit(edit));
    yield* thenable(() => open.save());
    return;
  }
  yield* thenable(() => vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(file))));
  yield* thenable(() => vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content)));
});

/** Scheme of the read-only documents on the left of the diffs: what a file held before the agent changed it. */
const DIFF_SCHEME = "code-acp-before";

/** Documents shown at most at once; older ones are dropped, and their diff tab shows nothing. */
const MAX_DIFF_DOCUMENTS = 50;

/** Serves the "before" side of the agent change diffs. */
export class BeforeDocuments implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly contents = new Map<string, string>();
  private nextId = 1;
  private readonly registration = vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, this);

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.query) ?? "";
  }

  /** Opens a diff of `before` against `file` as it is now (editable), or against `after` when given. */
  readonly open = Effect.fn("BeforeDocuments.open")(function* (
    this: BeforeDocuments,
    file: string,
    before: string | null,
    after?: string,
  ) {
    const left = this.add(file, before ?? "");
    const right = after === undefined ? vscode.Uri.file(file) : this.add(file, after);
    const title = t("changes.diffTitle", path.basename(file));
    yield* thenable(() => vscode.commands.executeCommand("vscode.diff", left, right, title, { preview: true }));
  });

  private add(file: string, content: string): vscode.Uri {
    const id = String(this.nextId++);
    this.contents.set(id, content);
    for (const key of this.contents.keys()) {
      if (this.contents.size <= MAX_DIFF_DOCUMENTS) {
        break;
      }
      this.contents.delete(key);
    }
    // The path keeps the file name, so the editor picks its language.
    return vscode.Uri.from({ scheme: DIFF_SCHEME, path: vscode.Uri.file(file).path, query: id });
  }

  dispose(): void {
    this.registration.dispose();
    this.contents.clear();
  }
}
