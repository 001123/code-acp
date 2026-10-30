import { assert, describe, it } from "@effect/vitest";
import { DiagnosticSeverity } from "./stubs/vscode";
import { formatProblems, type ProblemEntry } from "../src/problems";

const entry = (over: Partial<ProblemEntry>): ProblemEntry => ({
  path: "src/a.ts",
  line: 1,
  column: 1,
  severity: DiagnosticSeverity.Error,
  message: "boom",
  ...over,
});

describe("formatProblems", () => {
  it("lists errors before warnings, by file and position", () => {
    const text = formatProblems([
      entry({ severity: DiagnosticSeverity.Warning, message: "unused", source: "eslint", code: "no-unused-vars" }),
      entry({ path: "src/b.ts", line: 3, column: 5, message: "Cannot find name 'x'.", source: "ts", code: "2304" }),
      entry({ line: 7, message: "bad" }),
    ]);
    assert.strictEqual(
      text,
      [
        "src/a.ts:7:1 error: bad",
        "src/b.ts:3:5 error 2304: Cannot find name 'x'. (ts)",
        "src/a.ts:1:1 warning no-unused-vars: unused (eslint)",
      ].join("\n"),
    );
  });

  it("keeps one problem per line", () => {
    assert.strictEqual(formatProblems([entry({ message: "first\n  second" })]), "src/a.ts:1:1 error: first second");
  });

  it("counts the problems past the limit", () => {
    const text = formatProblems(Array.from({ length: 105 }, (_, i) => entry({ line: i + 1 })));
    const lines = text.split("\n");
    assert.strictEqual(lines.length, 101);
    assert.strictEqual(lines.at(-1), "… and 5 more");
  });
});
