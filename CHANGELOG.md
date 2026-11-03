# Changelog

All notable changes to this project are documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

First public version; nothing has been released yet.

### Added

- Chat with coding agents over the Agent Client Protocol, in tabs you can pin, rename and reorder, with a searchable history you can delete from.
- Install, update and switch agents from the ACP Registry, and add your own agents from local commands.
- Queue, edit, resend and retry messages, and fork a conversation into a new tab.
- A composer with live Markdown preview, drafts that survive reloads, and `/` agent commands and `$` skills.
- Permission requests, form questions, links to open after asking, plans, tools, subagents, terminals and context compaction in the chat.
- Rules that answer permission requests without asking, for all projects or one workspace, and for worktree chats.
- Model, effort and fast mode per tab, remembered for each agent, and modes for agents that only offer those.
- Compact a conversation from the context window panel, for agents that offer `/compact`.
- Log out of an agent.
- A first-run panel in the chat: it checks the tools agents need, then offers suggested agents or more, and the chat box appears once one is installed.
- A getting-started walkthrough, and a Doctor page in Settings (`Code ACP: Doctor`), which checks Node.js, npm, uv and git, starts each agent and offers to fix what it finds, such as a missing login.
- Attach files, folders, images, problems, terminals and selections as context, and annotate images.
- **Explain**, **Refactor**, **Write Tests** and **Fix with Code ACP** actions.
- Review the agent's changes with Keep and Undo, restore checkpoints, and follow the agent in the editor.
- Run a tab in its own git worktree and apply its changes to your checkout. Its branch is named after the first prompt, and those of Best of N go under `code-acp/compare/`.
- Best of N: tick Compare in the composer to send one prompt to several agents, models and efforts, each in its own worktree, grouped under one tab; compare their diffs and apply the best one, or discard them all.
- Copy ignored files and run a setup command when a worktree is created. A project can have its own command, which runs only after you allow it.
- Switch the Settings page between user and workspace settings.
- Commit message generation, then commit and push, from the Source Control view.
- Token and cost tracking, ccusage reports, status bar activity, background notifications and tracing.
- English and Vietnamese interfaces.

### Security

- Settings that decide what runs (custom agents, MCP servers, environment variables, Node and ccusage paths) apply only at machine scope, so a workspace cannot set them. A project's worktree setup command asks first, and asks again when the command or a file it names changes.
- Links from agents open only after asking, over https, or over http to localhost, 127.0.0.1 and hosts you list in Settings; a workspace cannot add to that list.
- Registry entries with unsafe paths are refused at install.
