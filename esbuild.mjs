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
  // React webviews, loaded by src/webview.ts from dist/webview/<page>.js.
  esbuild.context({
    ...common,
    entryPoints: ["src/ui/chat.tsx", "src/ui/manager.tsx", "src/ui/settings.tsx"],
    format: "iife",
    platform: "browser",
    target: "es2022",
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
