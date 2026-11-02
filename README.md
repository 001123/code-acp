# Code ACP

[![Version](https://img.shields.io/github/package-json/v/001123/code-acp?label=version)](package.json)
[![VS Code](https://img.shields.io/badge/VS%20Code-%E2%89%A51.123-007ACC)](https://code.visualstudio.com)
[![ACP](https://img.shields.io/badge/protocol-ACP-6E56CF)](https://agentclientprotocol.com)
[![License](https://img.shields.io/github/license/001123/code-acp)](LICENSE)

Chat with coding agents in VS Code over the [Agent Client Protocol](https://agentclientprotocol.com). Install Claude, Codex, OpenCode and more from the [ACP Registry](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json) in one click.

## Features

### Chat

- Chat in tabs you can pin, rename and reorder, and reopen past conversations from a searchable history.
- Queue messages while the agent works, edit and resend earlier ones, retry, or fork a conversation into a new tab.
- Write in a composer with live Markdown preview; drafts survive reloads. Use `/` for agent commands and `$` for skills.
- Answer the agent's permission requests and form questions in the chat, and follow its plans, tools, subagents and terminals.
- Pick the model, effort and fast mode per tab, and start from your last choices for each agent.

### Context

- Attach files, folders, images, problems and terminals with `@`, by pasting, or from the drop view. Optionally include the open file in every message.
- Add editor selections, terminal selections, the last command output or the last failed command with a command or shortcut.
- Run **Explain**, **Refactor** and **Write Tests** on a selection, or **Fix with Code ACP** on a problem.
- Preview images, draw on them with pen, arrow, rectangle and text, and open them in a separate window.

### Changes

- Review the agent's changes per file or per change, with Keep and Undo in the chat and in the editor.
- Restore the files to a checkpoint from before any message.
- Follow the agent in the editor: open the files it reads and edits, and highlight the lines it changes.
- Run each tab in a git worktree of its own, then apply its changes to your checkout as staged changes.

### Agents

- Install, update and switch agents from the **ACP Agents** page, with update checks on startup.
- Add your own agents from local commands, and pass extra MCP servers and environment variables to agents.

### Git, usage and status

- Generate commit messages from the Source Control view with your choice of agent, model, effort and instructions, then commit and push.
- Track tokens and cost by day, conversation and agent, or read the logs agents keep on your machine through [ccusage](https://github.com/ryoppippi/ccusage).
- See context window use and session cost in the chat, and activity and the tab's tokens and turns in the status bar.
- Get notified when a conversation in the background finishes or needs you.
- Turn on Tracing to see each turn's tokens, cost, context and duration in the chat, and every ACP message in a log.

### Language

- Use the interface in English or Vietnamese.

## Getting started

1. Run `Code ACP: Manage Agents` and install an agent.
2. Sign in with the **Login** button.
3. Start chatting.

`npx` agents need Node.js, `uvx` agents need [uv](https://docs.astral.sh/uv/). Settings are under `Code ACP: Open Settings`. Known limitations: [KNOWN_ISSUES.md](KNOWN_ISSUES.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
