# Known Issues

## Drag and drop files/folders into the chat box does not work

- [ ] Fixed

- **Since:** VS Code 1.140
- **Upstream:** [microsoft/vscode#339036](https://github.com/microsoft/vscode/issues/339036)
- **Symptom:** Dragging files or folders from the Explorer onto the chat composer does nothing; the drop never reaches the webview.
- **Cause:** VS Code bug — drag events from the Explorer are no longer delivered to webviews.
- **Workaround:** Drop onto the native drop tree view (`codeAcp.drop`, see `src/dropView.ts`), which still receives drags and attaches the items to the chat. Pasting also still works.
- **Follow-up:** Re-test the webview drop path once the upstream issue is fixed, then consider removing the drop view.

## Terminal selection is read through the clipboard

- [ ] Fixed

- **Since:** always (no stable API)
- **Upstream:** [microsoft/vscode#188173](https://github.com/microsoft/vscode/issues/188173) — `Terminal.selection` is still the proposed API `terminalSelection` (Backlog), unusable in a Marketplace extension.
- **Symptom:** "Add Terminal Selection to Chat" briefly overwrites the clipboard. Non-text clipboard content (images, files) is lost, and the selection has no line or command information.
- **Cause:** The stable API cannot read a terminal's selection, so `TerminalContext.selection` (`src/terminalContext.ts`) empties the clipboard, runs `workbench.action.terminal.copySelection`, reads the text and writes the previous text back.
- **Workaround:** None needed for text clipboards; copy non-text content again afterwards.
- **Follow-up:** Switch to `Terminal.selection` once it is finalized and drop the clipboard round trip.
