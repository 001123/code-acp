import { Context, Effect, FileSystem, Layer, Option, Path, Schema } from "effect";
import * as os from "node:os";

/** A window in tokens, or "auto" for the one Claude Code tunes per model. */
const CompactWindow = Schema.Union([Schema.Finite, Schema.Literal("auto")]);

/** The part of a Claude Code settings file that sets the auto-compact window. */
const ClaudeSettingsFile = Schema.Struct({
  autoCompactWindow: Schema.optional(CompactWindow),
  modelSettings: Schema.optional(
    Schema.Record(Schema.String, Schema.Struct({ autoCompactWindow: Schema.optional(CompactWindow) })),
  ),
});
type ClaudeSettingsFile = typeof ClaudeSettingsFile.Type;

const decodeSettingsFile = Schema.decodeUnknownOption(Schema.fromJsonString(ClaudeSettingsFile));

/**
 * Whether a `modelSettings` key names `model`. A key is the canonical name; it also matches the
 * dated, "[1m]", Bedrock ("us.anthropic.…-v1:0") and Vertex ("…@20250101") spellings.
 */
function keyMatches(key: string, model: string): boolean {
  const id = model.toLowerCase().replace(/\[[^\]]*\]$/, "");
  const at = id.indexOf(key.toLowerCase());
  if (at < 0 || (at > 0 && !/[./]$/.test(id.slice(0, at)))) {
    return false;
  }
  return /^([-@]\d{8})?(-v\d+(:\d+)?)?$/.test(id.slice(at + key.length));
}

/** The window one settings file sets for `model`: its `modelSettings` entry replaces the top-level value. */
function windowIn(file: ClaudeSettingsFile, model: string): Option.Option<number | "auto"> {
  const keys = Object.keys(file.modelSettings ?? {}).filter((key) => keyMatches(key, model));
  // The longest key is the most specific ("claude-opus-5-5" over "claude-opus-5").
  const key = keys.sort((a, b) => b.length - a.length)[0];
  const perModel = key === undefined ? undefined : file.modelSettings?.[key]?.autoCompactWindow;
  return Option.fromUndefinedOr(perModel ?? file.autoCompactWindow);
}

/** Claude Code's own settings files, read to show where it will auto-compact. */
export class ClaudeSettings extends Context.Service<ClaudeSettings, {
  /** The auto-compact window set for `model` in a session at `cwd`; none when unset or "auto". */
  readonly autoCompactWindow: (model: string, cwd: string) => Effect.Effect<Option.Option<number>>;
}>()("code-acp/ClaudeSettings") {
  static readonly layer = Layer.effect(
    ClaudeSettings,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");

      // A missing or unreadable file sets nothing.
      const readFile = (file: string) =>
        fs.readFileString(file).pipe(
          Effect.map(decodeSettingsFile),
          Effect.orElseSucceed(() => Option.none<ClaudeSettingsFile>()),
        );

      const autoCompactWindow = Effect.fn("ClaudeSettings.autoCompactWindow")(function* (model: string, cwd: string) {
        // Highest precedence first: local project, shared project, user.
        const files = [
          path.join(cwd, ".claude", "settings.local.json"),
          path.join(cwd, ".claude", "settings.json"),
          path.join(configDir, "settings.json"),
        ];
        for (const file of files) {
          const window = Option.flatMap(yield* readFile(file), (settings) => windowIn(settings, model));
          if (Option.isSome(window)) {
            return Option.filter(window, (value): value is number => value !== "auto" && value > 0);
          }
        }
        return Option.none<number>();
      });

      return ClaudeSettings.of({ autoCompactWindow });
    }),
  );
}
