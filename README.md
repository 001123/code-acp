# Code ACP for VS Code

VS Code extension for chatting with Claude through [Agent Client Protocol](https://agentclientprotocol.com), using the adapter [`@agentclientprotocol/claude-agent-acp`](https://github.com/agentclientprotocol/claude-agent-acp).

## Architecture

```
Webview chat (media/chat.js)  ⇄  ChatViewProvider  ⇄  AcpAgent (ACP client, @agentclientprotocol/sdk)
                                        │                     ⇅ stdio ndjson
ACP Agents page (media/manager.js)      │              installed agent (claude-acp, codex-acp, opencode, …)
        ⇅                               │
   ManagerPanel  ⇄  AgentManager  ──────┘
        │               installs into globalStorage/agents/<id>/<version>
        └─ ACP Registry: https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json
```

- `src/registry.ts`: loads the registry (uses a cache when offline).
- `src/agentManager.ts`: installs, updates, and removes agents based on the `distribution` in the registry:
  - `binary`: downloads the archive for the platform, checks SHA-256, extracts it.
  - `npx`: runs `npm install` in its own folder, runs the `bin` file with `node`.
  - `uvx`: runs `uvx <package>` (uv caches automatically).
- `src/managerPanel.ts`: the **ACP Agents** page: search, install, update, remove, and choose the agent to use.
- `src/acpClient.ts`: spawns the agent, `initialize`, `session/new|prompt|cancel`, handles `fs/read_text_file`, `fs/write_text_file` through the VS Code API.
- `src/chatViewProvider.ts`: session, permission request, sign-in (terminal auth), automatic restart when the agent changes.

## Running locally

```sh
npm install
npm run build
```

Open the folder in VS Code, press F5. The command `Code ACP: Manage Agents` (or the button on the chat panel) opens the ACP Agents page. Install an agent, for example Claude Agent; the first installed agent is selected automatically.

The agent needs to sign in: click **Đăng nhập** (Login) (or run the `Code ACP: Login` command). The extension runs the sign-in command that the agent declares in the terminal, then restarts the agent.

Check an agent outside VS Code:

```sh
node scripts/smoke.mjs --prompt "hello" -- <agent command> [args...]
```

## Settings

`Code ACP: Open Settings` (gear button on the chat panel) opens a settings page; values are saved to user settings.

| Setting | Description |
| --- | --- |
| `codeAcp.language` | Interface language: `auto` (follow VS Code), `en`, `vi` |
| `codeAcp.nodePath` | Node used to run agents installed through npm (default `node`) |
| `codeAcp.agentCommand` / `codeAcp.agentArgs` | Custom agent, overrides the agent selected from the registry |
| `codeAcp.env` | Extra environment variables for the agent |

## Requirements

- `npx` agents need `node` and `npm` in PATH; `uvx` agents need `uv`.
- Linux needs `unzip` for `.zip` archives.

## Packaging

`npm run package` creates a `.vsix` without any bundled agent (the SDK is bundled by esbuild into `dist/extension.js`).
