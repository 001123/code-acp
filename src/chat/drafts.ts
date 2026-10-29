import { Effect, FileSystem, PlatformError, Predicate, Schema, Semaphore } from "effect";
import { createHash } from "node:crypto";
import * as path from "node:path";
import type { Attachment, Draft } from "./protocol";

/** A draft attachment as saved; raw bytes live in a file of the drafts folder, named by their hash. */
export const SavedAttachment = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("uri"), uri: Schema.String, name: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("snippet"),
    uri: Schema.String,
    name: Schema.String,
    languageId: Schema.String,
    startLine: Schema.Int,
    endLine: Schema.Int,
    text: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("terminal"),
    name: Schema.String,
    terminal: Schema.String,
    shell: Schema.optional(Schema.String),
    commandLine: Schema.optional(Schema.String),
    cwd: Schema.optional(Schema.String),
    exitCode: Schema.optional(Schema.Int),
    text: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal("stored"), name: Schema.String, mimeType: Schema.String, file: Schema.String }),
]);
export type SavedAttachment = typeof SavedAttachment.Type;

export const SavedDraft = Schema.Struct({
  text: Schema.String,
  inline: Schema.Array(Schema.Struct({ token: Schema.String, attachment: SavedAttachment })),
  attachments: Schema.Array(SavedAttachment),
});
export type SavedDraft = typeof SavedDraft.Type;

/** The unsent content of a tab, as shown and as saved. */
export interface DraftHolder {
  /** Undefined when empty, or until `savedDraft` is loaded. */
  draft?: Draft;
  savedDraft?: SavedDraft;
}

/** Keeps the tabs' drafts across reloads: text in workspaceState (with the tabs), raw bytes in `dir`. */
export class DraftStore {
  /** Serializes writing draft files with removing the unused ones. */
  private readonly lock = Semaphore.makeUnsafe(1);

  constructor(
    private readonly dir: string,
    /** The drafts of the open tabs; files no draft refers to are removed. */
    private readonly holders: () => ReadonlyArray<DraftHolder>,
  ) {}

  /**
   * Keeps `update` as the unsent content of `holder`, writing raw bytes to the drafts folder. A string replaces
   * only the text: the attachments stay, and their files are not written again. `commit` runs inside the lock;
   * false drops the update (its tab closed meanwhile).
   */
  readonly set = Effect.fn("DraftStore.set")(function* (
    this: DraftStore,
    holder: DraftHolder,
    update: Draft | string,
    commit: () => boolean,
  ) {
    yield* Semaphore.withPermits(this.lock, 1)(
      Effect.gen({ self: this }, function* () {
        // Inside the lock: a "draft" sent just before has set the attachments by now.
        const textOnly = Predicate.isString(update);
        const draft = textOnly ? { inline: [], attachments: [], ...holder.draft, text: update } : update;
        const empty = !draft.text.trim() && draft.inline.length === 0 && draft.attachments.length === 0;
        const saved: SavedDraft | undefined = empty
          ? undefined
          : textOnly && holder.savedDraft
            ? { ...holder.savedDraft, text: draft.text }
            : {
                text: draft.text,
                inline: yield* Effect.forEach(draft.inline, ({ token, attachment }) =>
                  Effect.map(this.store(attachment), (stored) => ({ token, attachment: stored })),
                ),
                attachments: yield* Effect.forEach(draft.attachments, (a) => this.store(a)),
              };
        if (commit()) {
          holder.draft = empty ? undefined : draft;
          holder.savedDraft = saved;
        }
      }),
    );
    // Only attachments add or drop draft files.
    if (!Predicate.isString(update)) {
      yield* this.prune;
    }
  });

  /** Reads back the drafts saved before a reload; an attachment whose file is gone is dropped. */
  readonly load = Effect.fn("DraftStore.load")(function* (this: DraftStore) {
    for (const holder of this.holders()) {
      const saved = holder.savedDraft;
      if (!saved || holder.draft) {
        continue;
      }
      const inline = yield* Effect.forEach(saved.inline, ({ token, attachment }) =>
        Effect.map(this.restore(attachment), (loaded) => loaded.map((a) => ({ token, attachment: a }))),
      );
      const attachments = yield* Effect.forEach(saved.attachments, (a) => this.restore(a));
      holder.draft = { text: saved.text, inline: inline.flat(), attachments: attachments.flat() };
    }
  });

  /** Removes files of the drafts folder that no draft refers to. */
  get prune(): Effect.Effect<void, never, FileSystem.FileSystem> {
    return Semaphore.withPermits(this.lock, 1)(
      Effect.gen({ self: this }, function* () {
        const fs = yield* FileSystem.FileSystem;
        const used = new Set(
          this.holders().flatMap(({ savedDraft }) =>
            [...(savedDraft?.inline.map((x) => x.attachment) ?? []), ...(savedDraft?.attachments ?? [])].flatMap((a) =>
              a.kind === "stored" ? [a.file] : [],
            ),
          ),
        );
        const files = yield* fs.readDirectory(this.dir).pipe(Effect.orElseSucceed(() => []));
        yield* Effect.forEach(
          files.filter((file) => !used.has(file)),
          (file) => fs.remove(path.join(this.dir, file), { force: true }).pipe(Effect.ignore),
          { discard: true },
        );
      }),
    );
  }

  private store(a: Attachment): Effect.Effect<SavedAttachment, PlatformError.PlatformError, FileSystem.FileSystem> {
    if (a.kind !== "data") {
      return Effect.succeed(a);
    }
    return Effect.gen({ self: this }, function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = createHash("sha256").update(a.data).digest("hex");
      const target = path.join(this.dir, file);
      if (!(yield* fs.exists(target))) {
        yield* fs.makeDirectory(this.dir, { recursive: true });
        yield* fs.writeFile(target, Buffer.from(a.data, "base64"));
      }
      return { kind: "stored" as const, name: a.name, mimeType: a.mimeType, file };
    });
  }

  private restore(a: SavedAttachment): Effect.Effect<Attachment[], never, FileSystem.FileSystem> {
    if (a.kind !== "stored") {
      return Effect.succeed([a]);
    }
    return Effect.gen({ self: this }, function* () {
      const fs = yield* FileSystem.FileSystem;
      return yield* fs.readFile(path.join(this.dir, a.file)).pipe(
        Effect.map((bytes): Attachment[] => [{ kind: "data", name: a.name, mimeType: a.mimeType, data: Buffer.from(bytes).toString("base64") }]),
        Effect.orElseSucceed((): Attachment[] => []),
      );
    });
  }
}
