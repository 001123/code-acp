import { Context, Effect, FileSystem, Layer, Option, Path, Schema } from "effect";
import * as os from "node:os";
import * as vscode from "vscode";
import { thenable, type VscodeError } from "./runtime";

/** A workspace file or folder offered after "@". */
export interface FileSuggestion {
  uri: string;
  /** Base name; the token shows it. */
  name: string;
  /** Workspace-relative path, shown beside the name. */
  path: string;
  folder: boolean;
}

/** An agent skill (a folder with a SKILL.md) offered after "$". */
export interface SkillSuggestion {
  name: string;
  description: string;
  /** URI of the SKILL.md; it goes with the prompt as the skill's attachment. */
  uri: string;
}

/** Workspace files listed for "@"; more are not searched. */
const MAX_FILES = 20_000;
const MAX_FILE_RESULTS = 50;

/** The SKILL.md front matter the picker shows. */
const SkillFrontMatter = Schema.Struct({
  name: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
});
const decodeFrontMatter = Schema.decodeUnknownOption(SkillFrontMatter);

/** Single-line `key: value` pairs of a Markdown file's YAML front matter. */
function frontMatter(text: string): Record<string, string> {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
  const fields: Record<string, string> = {};
  for (const line of block.split(/\r?\n/)) {
    const m = /^([\w-]+):\s*(.*)$/.exec(line);
    if (m) fields[m[1]!] = m[2]!.trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return fields;
}

/** Glob of the folders `files.exclude` and `search.exclude` hide; ignore files are not read. */
function excludeGlob(): string {
  const config = vscode.workspace.getConfiguration();
  const globs = new Set(["**/.git"]);
  for (const key of ["files.exclude", "search.exclude"]) {
    for (const [glob, on] of Object.entries(config.get<Record<string, unknown>>(key) ?? {})) {
      if (on === true) globs.add(glob);
    }
  }
  return `{${[...globs].join(",")}}`;
}

/** How well `query` (lower case) matches a path; lower is better, undefined is no match. */
function rank(query: string, name: string, path: string): number | undefined {
  if (!query) return 0;
  const n = name.toLowerCase();
  const p = path.toLowerCase();
  if (n.startsWith(query)) return 0;
  if (n.includes(query)) return 1;
  if (p.includes(query)) return 2;
  // Characters in order, e.g. "chvp" for chatViewProvider.
  let at = 0;
  for (const ch of p) if (ch === query[at]) at++;
  return at === query.length ? 3 : undefined;
}

/** What the composer offers after "@" (workspace files) and "$" (skills). */
export class Completions extends Context.Service<Completions, {
  readonly files: (query: string) => Effect.Effect<ReadonlyArray<FileSuggestion>, VscodeError>;
  readonly skills: Effect.Effect<ReadonlyArray<SkillSuggestion>>;
}>()("code-acp/Completions") {
  static readonly layer = Layer.effect(
    Completions,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const list = thenable(() => vscode.workspace.findFiles("**/*", excludeGlob(), MAX_FILES)).pipe(
        Effect.map((uris) => {
          const entries = new Map<string, FileSuggestion>();
          for (const uri of uris) {
            const rel = vscode.workspace.asRelativePath(uri);
            entries.set(rel, { uri: uri.toString(), name: path.basename(rel), path: rel, folder: false });
            // Folders come from the files in them.
            let dir = path.dirname(rel);
            let folder = vscode.Uri.joinPath(uri, "..");
            while (dir !== "." && dir !== "/" && !entries.has(`${dir}/`)) {
              entries.set(`${dir}/`, { uri: folder.toString(), name: path.basename(dir), path: `${dir}/`, folder: true });
              dir = path.dirname(dir);
              folder = vscode.Uri.joinPath(folder, "..");
            }
          }
          return [...entries.values()];
        }),
      );
      /** The listing, read once and again after files are added, deleted or the folders change. */
      let cached: Effect.Effect<ReadonlyArray<FileSuggestion>, VscodeError> | undefined;
      const reset = () => {
        cached = undefined;
      };
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const watcher = vscode.workspace.createFileSystemWatcher("**/*", false, true, false);
          return vscode.Disposable.from(
            watcher,
            watcher.onDidCreate(reset),
            watcher.onDidDelete(reset),
            vscode.workspace.onDidChangeWorkspaceFolders(reset),
            vscode.workspace.onDidChangeConfiguration((e) => {
              if (e.affectsConfiguration("files.exclude") || e.affectsConfiguration("search.exclude")) reset();
            }),
          );
        }),
        (d) => Effect.sync(() => d.dispose()),
      );

      const files = Effect.fn("Completions.files")(function* (query: string) {
        // A failed listing is not kept.
        const listing = cached ?? (cached = yield* Effect.cached(list.pipe(Effect.tapError(() => Effect.sync(reset)))));
        const q = query.toLowerCase();
        return (yield* listing)
          .flatMap((f) => {
            const r = rank(q, f.name, f.path);
            return r === undefined ? [] : [{ f, r }];
          })
          .sort((a, b) => a.r - b.r || a.f.path.length - b.f.path.length || a.f.path.localeCompare(b.f.path))
          .slice(0, MAX_FILE_RESULTS)
          .map(({ f }) => f);
      });

      // Where Claude Code, Codex and other agents look for skills; the first one with a name wins.
      const skillRoots = () => {
        const home = os.homedir();
        const workspace = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === "file").map((f) => f.uri.fsPath);
        return [
          ...workspace.flatMap((dir) => [".claude", ".agents", ".codex"].map((d) => path.join(dir, d, "skills"))),
          path.join(process.env.CLAUDE_CONFIG_DIR || path.join(home, ".claude"), "skills"),
          path.join(process.env.CODEX_HOME || path.join(home, ".codex"), "skills"),
          path.join(home, ".agents", "skills"),
        ];
      };

      // A missing root or unreadable skill is skipped.
      const readSkill = (dir: string, entry: string) => {
        const file = path.join(dir, entry, "SKILL.md");
        return fs.readFileString(file).pipe(
          Effect.map((text) => {
            const meta = Option.getOrUndefined(decodeFrontMatter(frontMatter(text)));
            return Option.some<SkillSuggestion>({
              name: meta?.name || entry,
              description: meta?.description ?? "",
              uri: vscode.Uri.file(file).toString(),
            });
          }),
          Effect.orElseSucceed(() => Option.none<SkillSuggestion>()),
        );
      };

      const skills = Effect.gen(function* () {
        const found = new Map<string, SkillSuggestion>();
        for (const dir of skillRoots()) {
          const entries = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => []));
          for (const entry of entries.filter((e) => !e.startsWith(".")).sort()) {
            const skill = yield* readSkill(dir, entry);
            if (Option.isSome(skill) && !found.has(skill.value.name)) found.set(skill.value.name, skill.value);
          }
        }
        return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
      }).pipe(Effect.withSpan("Completions.skills"));

      return Completions.of({ files, skills });
    }),
  );
}
