import * as esbuild from "esbuild";
import { mkdirSync } from "node:fs";

const watch = process.argv.includes("--watch");
const production = process.argv.includes("--production");

const common = {
  bundle: true,
  loader: { ".svg": "text" },
  sourcemap: !production,
  minify: production,
};

const contexts = await Promise.all([
  esbuild.context({
    ...common,
    entryPoints: ["src/extension.ts"],
    format: "cjs",
    platform: "node",
    target: "node24",
    outfile: "dist/extension.js",
    external: ["vscode"],
  }),
  // React webviews and their styles, loaded by src/webview.ts from dist/webview/<page>.{js,css}.
  // chrome150 is the Chromium of VS Code 1.144 (Electron 43): keep it in sync with engines.vscode.
  esbuild.context({
    ...common,
    entryPoints: ["chat", "manager", "settings"].flatMap((page) => [
      { in: `src/ui/${page}.tsx`, out: page },
      { in: `media/${page}.css`, out: page },
    ]),
    format: "iife",
    platform: "browser",
    target: "chrome150",
    outdir: "dist/webview",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": JSON.stringify(production ? "production" : "development") },
  }),
]);

if (watch) {
  await Promise.all(contexts.map((ctx) => ctx.watch()));
} else {
  await Promise.all(contexts.map((ctx) => ctx.rebuild()));
  await Promise.all(contexts.map((ctx) => ctx.dispose()));
  // vsce package --out release/ does not create the directory
  if (production) mkdirSync("release", { recursive: true });
}
