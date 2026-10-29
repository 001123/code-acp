# AGENTS.md

VS Code extension "Code ACP": chat with coding agents over ACP, install agents from the ACP Registry.

## Rules

- Runtime: Node 24, VS Code ≥ 1.144. Keep `engines.vscode`, `@types/vscode`, `@types/node` and esbuild `target` in sync.
- Node APIs only; `vscode` stays external.
- Webviews are React (`src/ui/*.tsx`, bundled by esbuild to `dist/webview/`; styles stay in `media/*.css`). They may only `import type` from host modules.
- New `@types/*` package → add to `types` in `tsconfig.json`.
- Code, names, comments: English.
- User-facing strings: never hard-code. Add a key to `src/l10n/en.ts` and `src/l10n/vi.ts`; use `t()` from `src/i18n.ts` in the host, `useL10n().t` in webviews (`src/ui/l10n.ts`). `package.json` strings go in `package.nls.json` + `package.nls.vi.json`.
- Chat: reply in the conversation's language.
- Chat view: host in `src/chat/` (`chatViewProvider.ts` is the adapter; tabs, drafts, attachments, permissions, history, changes beside it), webview in `src/ui/chat.tsx` + `src/ui/chat/`. Messages shared by both live in `src/chat/protocol.ts`.
- Tests: `test/*.test.ts` with `@effect/vitest`; `vscode` is aliased to `test/stubs/vscode.ts` (extend it as needed), `test/fixtures/mock-agent.mjs` is an ACP agent over stdio.
- Run `npm run typecheck` and `npm test` before finishing.

## Effect

- Logic lives in Effect services (`Context.Service` + `Layer`) built into one `ManagedRuntime` in `src/runtime.ts`. VS Code classes (webviews, tree view, commands) are thin adapters that run effects with `runIn`.
- Validate untrusted data (registry, settings, globalState, package.json) with `Schema`. Errors are `Schema.TaggedError` with a user-facing `message`.
- Wrap VS Code `Thenable`s with `thenable()`; tie processes and other resources to a `Scope`.
- `typescript` is patched by `@effect/tsgo` (the `prepare` script). Only bump `typescript` to a version `@effect/tsgo` supports. `effect` and `@effect/platform-node-shared` are pinned exactly: FileSystem, Path, HttpClient and ChildProcess are unstable APIs.

# Learning more about Effect

This repository uses the Effect Typescript library.

Before writing any Effect code, first read `node_modules/effect/AGENTS.md`
**completely**, and follow the links in the file when required.

If you need to learn more about particular Effect apis and concepts that the
guide doesn't cover, search through the source code in `node_modules/effect/src`.
