import type * as acp from "@agentclientprotocol/sdk";
import { Context, Effect, FileSystem, Layer, Option, Schema } from "effect";
import * as path from "node:path";
import { ExtensionCtx, thenable, type VscodeError } from "../runtime";
import { ApprovalRules, readSettings } from "../settings";
import { mergeCall, type FollowedCall } from "./follow";

const KEY = "codeAcp.autoApprove";

/** The rule that covers each kind of tool call; a kind left out is always asked about. */
const RULE_OF_KIND: Partial<Record<acp.ToolKind, "read" | "edit" | "execute" | "fetch">> = {
  read: "read",
  search: "read",
  edit: "edit",
  move: "edit",
  execute: "execute",
  fetch: "fetch",
};

/** What `worktreeTabs` allows: `other` could be anything, and `switch_mode` could leave plan mode. */
const WORKTREE_KINDS: ReadonlyArray<acp.ToolKind> = ["read", "search", "edit", "move", "delete", "execute", "fetch"];

/** Folders where a written file can run something later: git hooks, VS Code tasks. Matched in any case, for macOS and Windows. */
const PROTECTED_FOLDERS: ReadonlyArray<string> = [".git", ".vscode"];

/** Whether the rules allow a tool call: outright, only when its paths are safe, or not at all. */
export type Verdict = "allow" | "ifPathsSafe" | "ask";

/** What the rules say about a tool call of `kind`. */
export const verdictOf = (rules: ApprovalRules, kind: acp.ToolKind | null | undefined, inWorktree: boolean): Verdict => {
  if (!kind) {
    return "ask";
  }
  if (inWorktree && rules.worktreeTabs === "allow" && WORKTREE_KINDS.includes(kind)) {
    return "allow";
  }
  const rule = RULE_OF_KIND[kind];
  if (!rule || rules[rule] !== "allow") {
    return "ask";
  }
  return rule === "read" || rule === "edit" ? "ifPathsSafe" : "allow";
};

/**
 * Whether a tool call of `kind` may touch `targets` without asking: there are some, all inside `root`, and none being
 * written is in a protected folder. All are resolved paths, so a link can't lead outside.
 */
export const pathsAreSafe = (kind: acp.ToolKind, root: string, targets: ReadonlyArray<string>): boolean =>
  targets.length > 0 &&
  targets.every((target) => {
    const relative = path.relative(root, target);
    const parts = relative.split(path.sep);
    return (
      parts[0] !== ".." &&
      !path.isAbsolute(relative) &&
      (RULE_OF_KIND[kind] !== "edit" || !parts.some((part) => PROTECTED_FOLDERS.includes(part.toLowerCase())))
    );
  });

/**
 * Where `target` really is, following links; a file that doesn't exist yet is placed in the nearest folder that does.
 * None when that can't be told, or for a link to nothing, as a write would land wherever it points.
 */
const resolvedPath = (fs: FileSystem.FileSystem, target: string): Effect.Effect<Option.Option<string>> =>
  fs.realPath(target).pipe(
    Effect.asSome,
    Effect.catch((error) => {
      const parent = path.dirname(target);
      if (error.reason._tag !== "NotFound" || parent === target) {
        return Effect.succeedNone;
      }
      return fs.readLink(target).pipe(
        Effect.as(Option.none<string>()),
        Effect.catch(() =>
          resolvedPath(fs, parent).pipe(Effect.map(Option.map((folder) => path.join(folder, path.basename(target))))),
        ),
      );
    }),
  );

/** A request the rules answered: the option to pick, and the tool call to name in the conversation. */
export interface AutoApproval {
  readonly optionId: string;
  readonly title: string | null | undefined;
}

/** The tab a permission request comes from. */
export interface ApprovalContext {
  readonly cwd: string;
  readonly inWorktree: boolean;
  /** What earlier updates said about the tool call: requests may carry little more than its id. */
  readonly known: FollowedCall | undefined;
}

/**
 * The rules that answer permission requests without asking. The user's are a setting; a workspace's stay in
 * workspaceState rather than in `.vscode/settings.json`, so that a repository can't grant itself anything.
 */
export class AutoApprove extends Context.Service<
  AutoApprove,
  {
    /** The rules of this workspace, those it leaves out following the user's. */
    readonly workspaceRules: Effect.Effect<ApprovalRules>;
    setWorkspaceRules(rules: ApprovalRules): Effect.Effect<void, VscodeError>;
    /** The answer the rules give to `request`, if any. Picks `allow_once`, so that the agent keeps no rule of its own. */
    approval(request: acp.RequestPermissionRequest, context: ApprovalContext): Effect.Effect<Option.Option<AutoApproval>>;
  }
>()("code-acp/AutoApprove") {
  static readonly layer = Layer.effect(
    AutoApprove,
    Effect.gen(function* () {
      const { workspaceState } = yield* ExtensionCtx;
      const fs = yield* FileSystem.FileSystem;

      const workspaceRules = Effect.sync(() =>
        Option.getOrElse(Schema.decodeUnknownOption(ApprovalRules)(workspaceState.get(KEY)), (): ApprovalRules => ({})),
      );

      const approval = Effect.fn("AutoApprove.approval")(function* (
        request: acp.RequestPermissionRequest,
        { cwd, inWorktree, known }: ApprovalContext,
      ) {
        const option = request.options.find((o) => o.kind === "allow_once");
        const call = mergeCall(known, request.toolCall);
        const rules = { ...readSettings().autoApprove, ...(yield* workspaceRules) };
        const verdict = verdictOf(rules, call.kind, inWorktree);
        if (!option || !call.kind || verdict === "ask") {
          return Option.none();
        }
        if (verdict === "ifPathsSafe") {
          const declared = [...call.locations.map((l) => l.path), ...call.diffs.map((d) => d.path)];
          const root = yield* resolvedPath(fs, cwd);
          const targets = yield* Effect.forEach(declared, (target) =>
            path.isAbsolute(target) ? resolvedPath(fs, target) : Effect.succeed(Option.none<string>()),
          );
          const resolved = Option.all(targets);
          if (Option.isNone(root) || Option.isNone(resolved) || !pathsAreSafe(call.kind, root.value, resolved.value)) {
            return Option.none();
          }
        }
        // The tool call's own title says more: a request's may only be "Run command".
        return Option.some<AutoApproval>({ optionId: option.optionId, title: known?.title ?? request.toolCall.title });
      });

      return AutoApprove.of({
        workspaceRules,
        setWorkspaceRules: (rules) =>
          thenable(() => workspaceState.update(KEY, Object.keys(rules).length > 0 ? rules : undefined)),
        approval,
      });
    }),
  );
}
