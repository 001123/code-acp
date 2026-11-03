# Code ACP

[![Version](https://img.shields.io/github/package-json/v/001123/code-acp?label=version)](package.json)
[![VS Code](https://img.shields.io/badge/VS%20Code-%E2%89%A51.123-007ACC)](https://code.visualstudio.com)
[![ACP](https://img.shields.io/badge/protocol-ACP-6E56CF)](https://agentclientprotocol.com)
[![License](https://img.shields.io/github/license/001123/code-acp)](LICENSE)

Chat with coding agents in VS Code over the [Agent Client Protocol](https://agentclientprotocol.com). Install Claude, Codex, OpenCode and more from the [ACP Registry](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json) in one click, then compare their work in isolated git worktrees.

## Getting started

Code ACP needs VS Code ≥ 1.123. There is no release yet, so build it from source with `npm install && npm run reinstall`.

1. Run `Code ACP: Manage Agents` and install an agent.
2. Open the chat in the secondary side bar with `Ctrl+Alt+A` (`Cmd+Alt+A` on macOS).
3. If the agent asks you to sign in, use the **Log in** button.
4. Start chatting.

`npx` agents need Node.js, `uvx` agents need [uv](https://docs.astral.sh/uv/). Settings are under `Code ACP: Open Settings`, for your user or the current workspace. Known limitations: [KNOWN_ISSUES.md](KNOWN_ISSUES.md).

## Features

### Chat

- Keep chats in an expandable sidebar of tabs you can pin, rename and reorder. Each row shows the requests waiting for you and the lines changed.
- Reopen past conversations from a searchable history, and delete the ones you no longer need.
- Queue messages while the agent works, edit and resend earlier ones, retry, or fork a conversation into a new tab.
- Write in a composer with live Markdown preview; drafts survive reloads. Use `/` for agent commands and `$` for skills.
- Answer the agent's permission requests, form questions and requests to open a link in the chat, and follow its plans, tools, subagents, terminals and context compaction.
- Let rules answer permission requests for you, for all projects or one workspace, or everything in worktree chats.
- Pick the model, effort and fast mode per tab, or the mode for agents that only offer those, and start from your last choices or the defaults you set for each agent.

### Context

- Attach files, folders, images, problems and terminals with `@`, by pasting, or from the drop view. Optionally include the open file in every message.
- Add editor selections, terminal selections, the last command output or the last failed command with a command or shortcut.
- Run **Explain**, **Refactor** and **Write Tests** on a selection, or **Fix with Code ACP** on a problem.
- Preview images, draw on them with pen, arrow, rectangle and text, and open them in a separate window.

### Changes

- Review the agent's changes per file or per change, with Keep and Undo in the chat and in the editor.
- Restore the files to a checkpoint from before any message.
- Follow the agent in the editor: open the files it reads and edits, and highlight the lines it changes.

### Worktrees

- Run a tab, or every new chat, in a git worktree of its own, on a branch named after the first prompt.
- Compare attempts with the Compare checkbox (Best of N): send one prompt to several agents, models and efforts. Each works in its own worktree under a group tab, where you compare their diffs and apply the best one, or discard them all.
- Finish a worktree from the button under the composer: merge it, create a pull request whose description its agent drafts (with the GitHub CLI), or copy its changes as staged changes. The bar then shows where the work went, a merge's conflicts, and the way to delete the worktree.
- Clean up the worktrees you no longer use in one go.
- Give new worktrees ignored files such as `.env` and `node_modules`, and run a setup command, your own or the project's after you allow it.

### Agents

- Install, update and switch agents from **Settings → Agent → Manage agents**, with update checks on startup.
- Add your own agents from local commands, and pass extra MCP servers and environment variables to agents.
- Log in to and out of an agent, or restart it, from the chat view's menu.

### Git, usage and status

- Generate commit messages from the Source Control view with your choice of agent, model, effort and instructions, then commit and push.
- Track tokens and cost by day, conversation and agent, or read the logs agents keep on your machine through [ccusage](https://github.com/ryoppippi/ccusage).
- See context window use and session cost in the chat, compact the conversation from there for agents that offer `/compact`, and see activity and the tab's tokens and turns in the status bar.
- Get notified when a conversation in the background finishes or needs you.
- Turn on Tracing to see each turn's tokens, cost, context and duration in the chat, and every ACP message in a log.

### Language

- Use the interface in English or Vietnamese.

## Keyboard shortcuts

| Action | Windows / Linux | macOS | When |
| --- | --- | --- | --- |
| Open the chat | `Ctrl+Alt+A` | `Cmd+Alt+A` | Anywhere |
| New chat tab | `Ctrl+Alt+N` | `Cmd+Alt+N` | Chat focused |
| Cancel | `Ctrl+.` | `Cmd+.` | Chat focused |
| Add selection to chat | `Ctrl+Alt+L` | `Cmd+Alt+L` | Text selected in the editor or terminal |
| Add file problems to chat | `Ctrl+Alt+P` | `Cmd+Alt+P` | Editor focused |

## Security

- Settings that decide what runs (custom agents, MCP servers, environment variables, Node and ccusage paths) apply only at machine scope, so a workspace cannot set them.
- A project's worktree setup command asks first, and asks again when the command or a file it names changes.
- Links from agents open only after asking, over https, or over http to localhost, 127.0.0.1 and hosts you list in Settings.
- Registry entries with unsafe paths are refused at install.
- Permission rules save clicks but are no security boundary: agents describe their own tools, and a worktree is no sandbox.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
