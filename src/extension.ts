import { Effect } from "effect";
import * as vscode from "vscode";
import { AgentManager } from "./agentManager";
import { ChatViewProvider } from "./chatViewProvider";
import { CommitMessage } from "./commitMessage";
import { DropViewProvider } from "./dropView";
import { t } from "./i18n";
import { ManagerPanel } from "./managerPanel";
import { makeRuntime, runIn, thenable, type AppServices } from "./runtime";
import { SettingsPanel } from "./settingsPanel";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const log = vscode.window.createOutputChannel("Code ACP");
  const runtime = makeRuntime(context, log);
  const manager = await runtime.runPromise(AgentManager.use(Effect.succeed));
  const showError = (message: string) => void vscode.window.showErrorMessage(`Code ACP: ${message}`);
  const run =
    <A extends Array<unknown>, E>(command: (...args: A) => Effect.Effect<void, E, AppServices>) =>
    (...args: A) =>
      runIn(runtime, Effect.suspend(() => command(...args)), showError);

  const provider = new ChatViewProvider(context, runtime, manager);
  const dropView = new DropViewProvider(run((uris: ReadonlyArray<vscode.Uri>) => provider.attach(uris)));

  const selectAgent = Effect.fn("selectAgent")(function* () {
    const manage = { label: t("agent.manage"), id: undefined as string | undefined };
    const activeId = yield* provider.activeAgentId;
    const items = (yield* manager.list).map((a) => ({
      label: a.name,
      description: a.version,
      detail: a.id === activeId ? t("agent.inUse") : undefined,
      id: a.id as string | undefined,
    }));
    const picked = yield* thenable(() => vscode.window.showQuickPick([...items, manage], { title: t("agent.pickTitle") }));
    if (picked === manage) {
      ManagerPanel.show(context, runtime, manager);
    } else if (picked?.id) {
      yield* provider.setAgent(picked.id);
    }
  });

  context.subscriptions.push(
    log,
    provider,
    dropView,
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.createTreeView(DropViewProvider.viewId, {
      treeDataProvider: dropView,
      dragAndDropController: dropView,
    }),
    vscode.commands.registerCommand("codeAcp.manageAgents", () => ManagerPanel.show(context, runtime, manager)),
    vscode.commands.registerCommand("codeAcp.selectAgent", run(selectAgent)),
    vscode.commands.registerCommand("codeAcp.openSettings", () => SettingsPanel.show(context, runtime, manager)),
    vscode.commands.registerCommand("codeAcp.newSession", run(() => provider.newSession())),
    vscode.commands.registerCommand("codeAcp.history", run(() => provider.showHistory())),
    vscode.commands.registerCommand("codeAcp.cancel", run(() => provider.cancel())),
    vscode.commands.registerCommand("codeAcp.login", run(() => provider.login())),
    vscode.commands.registerCommand("codeAcp.restart", run(() => provider.restart())),
    vscode.commands.registerCommand("codeAcp.showLog", () => log.show()),
    // scm/title passes the SourceControl; the palette passes nothing.
    vscode.commands.registerCommand(
      "codeAcp.generateCommitMessage",
      run((sourceControl?: unknown) => CommitMessage.use((commit) => commit.generate(sourceControl))),
    ),
    vscode.commands.registerCommand(
      "codeAcp.cancelCommitMessage",
      run(() => CommitMessage.use((commit) => commit.cancel)),
    ),
    // Explorer passes (clicked, selected[]); editor title/tab passes the tab's uri; palette passes nothing.
    vscode.commands.registerCommand(
      "codeAcp.attach",
      run((uri?: vscode.Uri, selected?: Array<vscode.Uri>) => {
        const target = vscode.window.activeTextEditor?.document.uri;
        const uris = selected?.length ? selected : uri instanceof vscode.Uri ? [uri] : target ? [target] : [];
        return uris.length ? provider.attach(uris) : Effect.void;
      }),
    ),
    vscode.commands.registerCommand(
      "codeAcp.addSelection",
      run(() => {
        const editor = vscode.window.activeTextEditor;
        return editor ? provider.attachSelection(editor) : Effect.void;
      }),
    ),
    // webview/context passes the merged `data-vscode-context` of the clicked element (see src/ui/chat.tsx).
    vscode.commands.registerCommand("codeAcp.quoteSelection", (context?: { selectedText?: unknown }) => {
      if (typeof context?.selectedText === "string") {
        provider.quote(context.selectedText);
      }
    }),
    // Last, so services (e.g. the AgentManager event emitter) outlive everything above.
    { dispose: () => void runtime.dispose() },
  );
}

export function deactivate(): void {}
