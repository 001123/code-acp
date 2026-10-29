# Code ACP

Chat with coding agents in VS Code over the [Agent Client Protocol](https://agentclientprotocol.com). Install Claude, Codex, OpenCode and more from the [ACP Registry](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json) in one click.

## Features

- Chat in tabs with history, queued messages, edits and conversation forks.
- Attach files, images, editor selections and terminal output (`@` in the composer).
- Review the agent's changes, restore checkpoints, follow subagents and terminals.
- Install, update and switch agents from the **ACP Agents** page, or add your own.
- Generate commit messages from the Source Control view.
- Multilingual UI.

## Getting started

1. Run `Code ACP: Manage Agents` and install an agent.
2. Sign in with the **Login** button.
3. Start chatting.

`npx` agents need Node.js, `uvx` agents need [uv](https://docs.astral.sh/uv/). Settings are under `Code ACP: Open Settings`. Known limitations: [KNOW_ISSUES.md](KNOW_ISSUES.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
