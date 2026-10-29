# Contributing

Requires Node 24 and VS Code ≥ 1.144.

```sh
npm install
npm run build      # or: npm run watch
npm run typecheck
npm test
npm run package    # .vsix in release/
npm run reinstall  # package and install into your local VS Code
```

Press F5 in VS Code to launch an Extension Development Host. Test an agent outside VS Code:

```sh
node scripts/smoke.mjs --prompt "hello" -- <agent command> [args...]
```

## Layout

- `src/runtime.ts`: logic lives in Effect services built into one runtime; VS Code classes are thin adapters.
- `src/chat/`: chat view host; `src/ui/`: React webviews (styles in `media/`).
- `src/l10n/`: UI strings (`en.ts`, `vi.ts`); `package.nls*.json` for `package.json` strings.
- `test/`: vitest tests, with `test/fixtures/mock-agent.mjs` as an ACP agent over stdio.

See [AGENTS.md](AGENTS.md) for the full conventions.

## Settings

| Setting | Description |
| --- | --- |
| `codeAcp.language` | `auto`, `en`, `vi` |
| `codeAcp.customAgents` | Your own ACP agents (command, args, env by name), listed next to the installed ones |
| `codeAcp.env` | Extra environment variables for the agent |
| `codeAcp.nodePath` | Node for npm agents (default `node`) |
| `codeAcp.checkAgentUpdates` | Check for agent updates daily |
| `codeAcp.commitMessage.agent` / `.model` / `.instructions` | Agent, model and extra instructions for commit messages |

## Terminal context

The agent gets the command, shell, cwd, exit code and the last 200 lines of plain-text output. Output needs [shell integration](https://code.visualstudio.com/docs/terminal/shell-integration) and only covers commands run after VS Code started. Terminal selections go through the clipboard ([microsoft/vscode#188173](https://github.com/microsoft/vscode/issues/188173)); see [KNOWN_ISSUES.md](KNOWN_ISSUES.md).
