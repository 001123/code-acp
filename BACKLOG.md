# Backlog

Open work for Code ACP, as of 2026-11-06. What has shipped is in [CHANGELOG.md](CHANGELOG.md); remove an item from here once it is done and add it there.

## Release

- [ ] **R1. First release.** The version is still `0.0.1` and `CHANGELOG.md` has only `[Unreleased]`. Pick a version, date the changelog, publish the `.vsix` (Marketplace and Open VSX), and let the release run CI.

## Quality

- [ ] **Q1. Tests for modules that have none:** `completions.ts`, `terminalContext.ts`, `claudeSettings.ts`, and direct tests for `agentTerminals.ts` (covered only through `acpClient` today).

## Features

### Review and verification

- [ ] **F1. Checks after each turn.** Run a command such as `npm run check` when the agent finishes, send failures back as the next prompt, and stop after a set number of rounds. Fits beside the worktree setup command in settings.
- [ ] **F2. Comments on diffs.** Comment on hunks in the changes review and send them to the agent as one batch, on top of Keep and Undo.

### Sidebar

- [ ] **F3. Filter tabs that need the user.** Rows already show pending requests and changed lines; add a filter (or a group) for tabs waiting on a permission, question or login.

### Composer

- [ ] **F4. More `@` mentions:** `@git-diff` (working tree or a branch), `@symbol` (workspace symbols) and `@url`.
- [ ] **F5. Per-project prompt library.** Saved prompts stored in the workspace, offered next to `/` commands and `$` skills.

### History and usage

- [ ] **F6. Client-side history** for agents without `session/list`: keep the sessions Code ACP created so History still lists them and can reopen them when the agent supports `session/load`.
- [ ] **F7. Budget alerts.** Warn when the usage ledger passes a daily or monthly cost set in settings, per agent or overall.

## Watching

Unstable in the ACP SDK; wait for wider agent support before building.

- [ ] **W1.** `nes/*`: inline next-edit suggestions in the editor.
- [ ] **W2.** `providers/*`: choosing a model provider through the agent (today `codeAcp.providers` is only local preferences).
