# Known Issues

## Drag and drop files/folders into the chat box does not work

- [ ] Fixed

- **Since:** VS Code 1.140
- **Upstream:** [microsoft/vscode#339036](https://github.com/microsoft/vscode/issues/339036)
- **Symptom:** Dragging files or folders from the Explorer onto the chat composer does nothing; the drop never reaches the webview.
- **Cause:** VS Code bug — drag events from the Explorer are no longer delivered to webviews.
- **Workaround:** Drop onto the native drop tree view (`codeAcp.drop`, see `src/dropView.ts`), which still receives drags and attaches the items to the chat. Pasting also still works.
- **Follow-up:** Re-test the webview drop path once the upstream issue is fixed, then consider removing the drop view.
