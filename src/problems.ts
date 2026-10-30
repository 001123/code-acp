import { Context, Effect, Layer, Option } from "effect";
import * as path from "node:path";
import * as vscode from "vscode";
import type { Attachment } from "./chat/protocol";
import { t } from "./i18n";

/** Which problems an "@" pick attaches: the active editor's, or the whole workspace's. */
export type ProblemScope = "file" | "workspace";

/** Problems offered after "@", next to the files. */
export interface ProblemSuggestion {
  scope: ProblemScope;
  label: string;
  detail: string;
}

/** One diagnostic as the prompt lists it; `line` and `column` are 1-based. */
export interface ProblemEntry {
  path: string;
  line: number;
  column: number;
  severity: vscode.DiagnosticSeverity;
  message: string;
  source?: string;
  code?: string;
}

/** A prompt lists at most this many problems; the rest are counted. */
const MAX_PROBLEMS = 100;

/** Lines of code shown around the problems a quick fix attaches. */
const CONTEXT_LINES = 3;

const SEVERITY = ["error", "warning", "info", "hint"] as const;

/** The problems as lines an agent reads, most severe first, e.g. `src/a.ts:3:5 error TS2304: Cannot find name 'x'. (ts)`. */
export function formatProblems(entries: ReadonlyArray<ProblemEntry>): string {
  const sorted = [...entries].sort(
    (a, b) => a.severity - b.severity || a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column,
  );
  const lines = sorted.slice(0, MAX_PROBLEMS).map((p) => {
    const code = p.code ? ` ${p.code}` : "";
    const source = p.source ? ` (${p.source})` : "";
    // Messages may span lines (e.g. TypeScript's elaborations); keep one problem per line.
    const message = p.message.replace(/\s*\r?\n\s*/g, " ");
    return `${p.path}:${p.line}:${p.column} ${SEVERITY[p.severity] ?? "error"}${code}: ${message}${source}`;
  });
  if (sorted.length > MAX_PROBLEMS) {
    lines.push(`… and ${sorted.length - MAX_PROBLEMS} more`);
  }
  return lines.join("\n");
}

function codeOf(diagnostic: vscode.Diagnostic): string | undefined {
  const code = diagnostic.code;
  if (code === undefined) {
    return undefined;
  }
  return String(typeof code === "object" ? code.value : code);
}

function entryOf(uri: vscode.Uri, diagnostic: vscode.Diagnostic): ProblemEntry {
  return {
    path: uri.scheme === "file" ? vscode.workspace.asRelativePath(uri) : uri.toString(),
    line: diagnostic.range.start.line + 1,
    column: diagnostic.range.start.character + 1,
    severity: diagnostic.severity,
    message: diagnostic.message,
    source: diagnostic.source,
    code: codeOf(diagnostic),
  };
}

/** Errors and warnings; infos and hints are mostly noise for an agent. */
const relevant = (d: vscode.Diagnostic) => d.severity <= vscode.DiagnosticSeverity.Warning;

/** The Problems panel as composer attachments: "@" picks and the "Fix with Code ACP" quick fix. */
export class Problems extends Context.Service<Problems, {
  readonly suggestions: (query: string) => Effect.Effect<ReadonlyArray<ProblemSuggestion>>;
  /** The errors and warnings of the active editor's file, or of the workspace; none when there are none. */
  readonly attachment: (scope: ProblemScope) => Effect.Effect<Option.Option<Attachment>>;
  /** `diagnostics` of `uri` and the code around them, for a quick fix. */
  readonly forDiagnostics: (uri: vscode.Uri, diagnostics: ReadonlyArray<vscode.Diagnostic>) => Effect.Effect<Attachment[]>;
}>()("code-acp/Problems") {
  static readonly layer = Layer.succeed(
    Problems,
    (() => {
      const activeUri = () => {
        const uri = vscode.window.activeTextEditor?.document.uri;
        return uri?.scheme === "file" ? uri : undefined;
      };

      const collect = (scope: ProblemScope): Array<ProblemEntry> => {
        if (scope === "file") {
          const uri = activeUri();
          return uri ? vscode.languages.getDiagnostics(uri).filter(relevant).map((d) => entryOf(uri, d)) : [];
        }
        return vscode.languages.getDiagnostics().flatMap(([uri, ds]) => ds.filter(relevant).map((d) => entryOf(uri, d)));
      };

      const nameOf = (scope: ProblemScope) => {
        const uri = activeUri();
        return scope === "file" && uri ? t("problems.file", path.basename(uri.path)) : t("problems.workspace");
      };

      const detailOf = (entries: ReadonlyArray<ProblemEntry>) => {
        const errors = entries.filter((e) => e.severity === vscode.DiagnosticSeverity.Error).length;
        return t("problems.count", errors, entries.length - errors);
      };

      const suggestions = (query: string) =>
        Effect.sync(() => {
          const q = query.toLowerCase();
          return (["file", "workspace"] as const).flatMap((scope): ProblemSuggestion[] => {
            const label = nameOf(scope);
            // The English word matches too, so "@problems" works in every language.
            if (q && !label.toLowerCase().includes(q) && !"problems".includes(q)) {
              return [];
            }
            const entries = collect(scope);
            // The file's problems are the workspace's when it is the only file with some.
            if (!entries.length || (scope === "workspace" && entries.length === collect("file").length)) {
              return [];
            }
            return [{ scope, label, detail: detailOf(entries) }];
          });
        });

      const attachment = (scope: ProblemScope) =>
        Effect.sync(() => {
          const entries = collect(scope);
          return entries.length
            ? Option.some<Attachment>({ kind: "problems", name: nameOf(scope), text: formatProblems(entries) })
            : Option.none<Attachment>();
        });

      const forDiagnostics = (uri: vscode.Uri, diagnostics: ReadonlyArray<vscode.Diagnostic>) =>
        Effect.sync((): Attachment[] => {
          if (!diagnostics.length) {
            return [];
          }
          const problems: Attachment = {
            kind: "problems",
            name: t("problems.file", path.basename(uri.path)),
            text: formatProblems(diagnostics.map((d) => entryOf(uri, d))),
          };
          const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
          if (!doc) {
            return [problems];
          }
          const first = Math.max(0, Math.min(...diagnostics.map((d) => d.range.start.line)) - CONTEXT_LINES);
          const last = Math.min(doc.lineCount - 1, Math.max(...diagnostics.map((d) => d.range.end.line)) + CONTEXT_LINES);
          const range = new vscode.Range(first, 0, last, doc.lineAt(last).text.length);
          const snippet: Attachment = {
            kind: "snippet",
            uri: uri.toString(),
            name: `${path.basename(uri.path)}:${first === last ? first + 1 : `${first + 1}-${last + 1}`}`,
            languageId: doc.languageId,
            startLine: first + 1,
            endLine: last + 1,
            text: doc.getText(range),
          };
          return [problems, snippet];
        });

      return Problems.of({ suggestions, attachment, forDiagnostics });
    })(),
  );
}

/** Offers "Fix with Code ACP" on the problems under the cursor. */
export class FixProblemsActions implements vscode.CodeActionProvider {
  static readonly kinds = [vscode.CodeActionKind.QuickFix];

  provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    if (!context.diagnostics.length) {
      return [];
    }
    const action = new vscode.CodeAction(t("problems.fix"), vscode.CodeActionKind.QuickFix);
    action.command = { command: "codeAcp.fixProblems", title: t("problems.fix"), arguments: [document.uri, [...context.diagnostics]] };
    return [action];
  }
}
