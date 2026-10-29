# Code ACP

VS Code extension for chatting with coding agents over the [Agent Client Protocol](https://agentclientprotocol.com). Install agents (Claude, Codex, OpenCode, …) from the [ACP Registry](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json).

## Features

- Chat in tabs, with conversation history, file/image attachments and editor selections.
- **ACP Agents** page: search, install, update, remove and select agents. Daily update checks.
- Generate commit messages and commit & push from the Source Control view.
- English and Vietnamese UI.

## Getting started

1. `Code ACP: Manage Agents` → install an agent (the first one is selected automatically).
2. Sign in with the **Login** button or `Code ACP: Login`.
3. Start chatting.

Requirements: `npx` agents need `node` + `npm`, `uvx` agents need `uv`; Linux needs `unzip`.

## Settings

Open with `Code ACP: Open Settings` (gear button on the chat panel).

| Setting | Description |
| --- | --- |
| `codeAcp.language` | `auto`, `en`, `vi` |
| `codeAcp.agentCommand` / `codeAcp.agentArgs` | Custom agent, overrides the registry agent |
| `codeAcp.env` | Extra environment variables for the agent |
| `codeAcp.nodePath` | Node for npm agents (default `node`) |
| `codeAcp.checkAgentUpdates` | Check for agent updates daily |
| `codeAcp.commitMessage.agent` / `.model` / `.instructions` | Agent, model and extra instructions for commit messages |

## Development

```sh
npm install
npm run build      # or: npm run watch
npm run typecheck
npm run package    # .vsix in release/
```

Press F5 in VS Code to launch. Test an agent outside VS Code:

```sh
node scripts/smoke.mjs --prompt "hello" -- <agent command> [args...]
```

Layout: logic lives in Effect services (`src/runtime.ts`), webviews are React (`src/ui/`). See [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)
