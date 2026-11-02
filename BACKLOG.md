# Backlog

From the project review of 2026-11-02. Check an item when it is done; line numbers are from that date.

## Suggested order

1. Bugs B1–B3 with tests, then M1 and M2.
2. Features F1 and F2.
3. Feature F6.

## Bugs

### High

- [x] **B1. Inline `file://` code with a stray `%` crashes rendering.** `` `file:///tmp/100%.txt` `` makes `decodeURIComponent` throw `URIError` during render (reproduced with `renderToString`). The webview has no error boundary, so the whole chat probably goes blank. Catch the error, and add an error boundary. `src/ui/markdown.tsx:61`
- [x] **B2. A message is lost when its session can't be created.** The composer clears right after posting, and the turn returns without a session (login needed, no agent, agent failed to start). Put the message back in the composer or keep it queued. `src/ui/chat/composer.tsx:245`, `src/chat/turns.ts:260`
- [x] **B3. Terminal login and agent restart wipe conversations.** `restart` resets the conversation, `reopen` and the queue of every tab on the agent, which contradicts "Auth errors keep `reopen`". Restarting after an agent update does the same. Keep `reopen` when the agent can reopen sessions. `src/chat/tabAgents.ts:260`, `src/chat/tabAgents.ts:311`, `src/chat/sessions.ts:112`

### Medium

- [x] **B4. Workspace settings can change what gets executed.** `customAgents`, `env`, `nodePath`, `ccusagePath` and `mcpServers` declare no `scope`, so a trusted repo's `.vscode/settings.json` can set them (e.g. `NODE_OPTIONS`). Use `machine` scope; ask for confirmation if workspace MCP servers stay allowed. `package.json`
- [x] **B5. Registry values reach file paths unchecked.** `agent.id`, `version` and `cmd` aren't checked for `..`, and `removeDir(dir)` deletes recursively from them. `sha256` is also optional (stays optional, with a warning: 37 of 116 registry targets have none). `src/registry.ts`, `src/agentManager.ts:220`, `src/agentManager.ts:259`

### Low

- [x] **B6. `fs/read_text_file` opens a document for every read.** `openTextDocument` can activate language servers for each file the agent reads. Use the buffer only for files already open, else read from disk. `src/acpClient.ts:316`
- [x] **B7. Notices and stop reasons are handled poorly.** `notice` reads the wrong fields and the `session.notices` capability isn't advertised, and stop reasons show raw (`Stopped: max_tokens`). `src/ui/chat.tsx:181`, `src/ui/chat.tsx:298`
- [ ] **B8. `compaction_*` and `current_mode_update` are dropped silently.** Compaction needs a transcript item (upserts by ID, summary chunks) before advertising `session.compaction`. Modes have no UI; a notice may be enough. `src/ui/chat.tsx`

## Maintenance

- [x] **M1. Add CI** running `npm run check`.
- [x] **M2. Align versions.** `@types/vscode` stays on 1.120 (1.123 was never published) and must not be newer than `engines.vscode`; `CONTRIBUTING.md` now says ≥ 1.123.
- [ ] **M3. Plan a first release.** The version is still 0.0.1; `CHANGELOG.md` is in place.
- [x] **M4. Upgrade `@agentclientprotocol/sdk`** from 2.1.0 to 2.4.0.
- [ ] **M5. Add tests** for `completions`, `terminalContext` and `claudeSettings` (none yet), and direct ones for `agentTerminals`.
- [x] **M6. Split `src/ui/settings.tsx`** into `src/ui/settings/`.
- [x] **M7. Fix the "Multilingual" typo.** Already gone from `README.md`.

## Features

### Next

- [ ] **F1. Worktree setup.** Run a script or copy `.env` and `node_modules` when a worktree is created; ignored files are missing from new worktrees today.
- [ ] **F2. Permission auto-approval rules.** For example, allow file reads, or allow everything in worktree tabs. Every request needs a manual answer today.
- [ ] **F3. Checks after each turn.** Run a command such as `npm run check` when the agent finishes and send failures back, with a limit on rounds.
- [ ] **F4. Comments on diffs.** Comment on hunks and send them to the agent as one batch, on top of the keep/undo review.
- [x] **F5. Missing ACP support.**
  - [x] `session/delete` in History
  - [x] `logout`
  - [x] `session/set_mode` for agents that only offer modes
  - [x] URL elicitations
  - [x] Compaction shown in the transcript

### Differentiators

- [ ] **F6. Best of N.** Send one prompt to several agents, each in its own worktree, then compare the diffs and apply the best one.
- [ ] **F7. Overview board.** One screen with every tab's status, worktree, changed files and pending requests.
- [ ] **F8. Finishing a worktree.** Merge, open a PR with a generated description, clean up old worktrees.

### Small

- [ ] **F9.** `@git-diff`, `@symbol` and `@url` in the composer.
- [ ] **F10.** Per-project prompt library.
- [ ] **F11.** Export a conversation to Markdown, and search inside the transcript.
- [ ] **F12.** Client-side history for agents without `session/list`.
- [ ] **F13.** Budget alerts from the usage ledger.
- [ ] **F14.** Getting-started walkthrough, and a "Doctor" command checking node, uv and login.

## Watching

Unstable in the SDK; wait for wider agent support.

- [ ] **W1.** `nes/*` (inline next-edit suggestions).
- [ ] **W2.** `providers/*` (choosing a model provider).
