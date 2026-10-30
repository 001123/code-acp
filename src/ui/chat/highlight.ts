import { createCssVariablesTheme, createHighlighterCoreSync, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import c from "shiki/langs/c.mjs";
import css from "shiki/langs/css.mjs";
import diff from "shiki/langs/diff.mjs";
import go from "shiki/langs/go.mjs";
import html from "shiki/langs/html.mjs";
import java from "shiki/langs/java.mjs";
import javascript from "shiki/langs/javascript.mjs";
import json from "shiki/langs/json.mjs";
import kotlin from "shiki/langs/kotlin.mjs";
import markdown from "shiki/langs/markdown.mjs";
import python from "shiki/langs/python.mjs";
import rust from "shiki/langs/rust.mjs";
import shellscript from "shiki/langs/shellscript.mjs";
import sql from "shiki/langs/sql.mjs";
import toml from "shiki/langs/toml.mjs";
import tsx from "shiki/langs/tsx.mjs";
import yaml from "shiki/langs/yaml.mjs";

/*
 * Syntax highlighting for fenced code in the composer: Shiki with its JavaScript regex engine (the webview CSP allows no
 * WebAssembly) and a bundled set of common grammars. Colors are CSS variables, set per VS Code theme in chat.css.
 */

/** Grammar and display name by fence language; TSX covers TypeScript and JavaScript covers JSX. */
const LANGUAGES: Record<string, [grammar: string, name: string]> = {};
const define = (grammar: string, name: string, aliases: string[]) => {
  for (const alias of aliases) LANGUAGES[alias] = [grammar, name];
};
define("javascript", "JavaScript", ["javascript", "js", "jsx", "mjs", "cjs"]);
define("tsx", "TypeScript", ["typescript", "ts", "tsx", "mts", "cts"]);
define("json", "JSON", ["json", "jsonc", "json5"]);
define("python", "Python", ["python", "py"]);
define("shellscript", "Shell", ["shellscript", "shell", "sh", "bash", "zsh", "console"]);
define("css", "CSS", ["css"]);
define("html", "HTML", ["html", "xml", "svg", "vue", "svelte"]);
define("yaml", "YAML", ["yaml", "yml"]);
define("rust", "Rust", ["rust", "rs"]);
define("go", "Go", ["go", "golang"]);
define("java", "Java", ["java"]);
define("kotlin", "Kotlin", ["kotlin", "kt", "kts"]);
define("c", "C", ["c", "h", "cpp", "c++", "cc", "hpp", "objc"]);
define("sql", "SQL", ["sql"]);
define("diff", "Diff", ["diff", "patch"]);
define("toml", "TOML", ["toml"]);
define("markdown", "Markdown", ["markdown", "md"]);

/** The language of a fence's info string (```ts title="x" → TypeScript), if it is one we highlight. */
export function fenceLanguage(info: string): { grammar: string; name: string } | undefined {
  const word = /^\s*([^\s{`]+)/.exec(info)?.[1]?.toLowerCase();
  const found = word === undefined ? undefined : LANGUAGES[word];
  return found && { grammar: found[0], name: found[1] };
}

/** A colored range of one line of code. */
export interface CodeToken {
  from: number;
  to: number;
  style: string;
}

let highlighter: HighlighterCore | undefined;
const cache = new Map<string, CodeToken[][]>();
const CACHE_SIZE = 32;

/** Colored ranges for each line of `code`, highlighted as `grammar` (from `fenceLanguage`). */
export function highlight(grammar: string, code: string): CodeToken[][] {
  const key = `${grammar}\n${code}`;
  const hit = cache.get(key);
  if (hit) return hit;
  highlighter ??= createHighlighterCoreSync({
    engine: createJavaScriptRegexEngine({ forgiving: true }),
    themes: [createCssVariablesTheme({ name: "composer", variablePrefix: "--hl-", fontStyle: true })],
    langs: [c, css, diff, go, html, java, javascript, json, kotlin, markdown, python, rust, shellscript, sql, toml, tsx, yaml],
  });
  const lines = highlighter.codeToTokensBase(code, { lang: grammar, theme: "composer" }).map((tokens) => {
    const out: CodeToken[] = [];
    let at = 0;
    for (const token of tokens) {
      const style = tokenStyle(token.color, token.fontStyle ?? 0);
      if (style) out.push({ from: at, to: at + token.content.length, style });
      at += token.content.length;
    }
    return out;
  });
  if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value!);
  cache.set(key, lines);
  return lines;
}

function tokenStyle(color: string | undefined, fontStyle: number): string {
  let style = color && !color.includes("--hl-foreground") ? `color: ${color};` : "";
  if (fontStyle & 1) style += " font-style: italic;";
  if (fontStyle & 2) style += " font-weight: bold;";
  return style.trim();
}
