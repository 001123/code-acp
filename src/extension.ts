import { Effect } from "effect";
import * as vscode from "vscode";
import { AgentManager } from "./agentManager";
import { AgentUpdates } from "./agentUpdates";
import { ChatViewProvider } from "./chat/chatViewProvider";
import { CommitMessage } from "./commitMessage";
import { DropViewProvider } from "./dropView";
import { t } from "./i18n";
import { ManagerPanel } from "./managerPanel";
import { FixProblemsActions } from "./problems";
import { makeRuntime, runIn, thenable, type AppServices } from "./runtime";
import { SettingsPanel } from "./settingsPanel";

const UPDATE_POLL_MS = 60 * 60 * 1000;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const log = vscode.window.createOutputChannel("Code ACP");
  const runtime = makeRuntime(context, log);
  const manager = await runtime.runPromise(AgentManager.use(Effect.succeed));
  const showError = (message: string) => void vscode.window.showErrorMessage(`Code ACP: ${message}`);
  const run =
    <A extends Array<unknown>, E>(command: (...args: A) => Effect.Effect<void, E, AppServices>) =>
    (...args: A) =>
      runIn(runtime, Effect.suspend(() => command(...args)), showError);

  const updates = await runtime.runPromise(AgentUpdates.use(Effect.succeed));
  const provider = new ChatViewProvider(context, runtime, manager, updates);
  const dropView = new DropViewProvider(run((uris: ReadonlyArray<vscode.Uri>) => provider.attach(uris)));

  const selectAgent = Effect.fn("selectAgent")(function* () {
    const manage = { label: t("agent.manage"), id: undefined as string | undefined };
    const activeId = yield* provider.activeAgentId;
    const items = (yield* manager.agents).map((a) => ({
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

  /** Offers to install the updates a background check found. */
  const offerUpdates = Effect.fn("offerUpdates")(function* () {
    const due = yield* updates.due;
    if (!due.length) {
      return;
    }
    const list = due.map((u) => `${u.latest.name} ${u.installed.version} → ${u.latest.version}`).join(", ");
    const [update, manage, disable] = [t("updates.update"), t("settings.manageAgents"), t("updates.disable")];
    const picked = yield* thenable(() => vscode.window.showInformationMessage(t("updates.available", list), update, manage, disable));
    if (picked === update) {
      yield* provider.updateAgents(due);
    } else if (picked === manage) {
      ManagerPanel.show(context, runtime, manager);
    } else if (picked === disable) {
      yield* thenable(() =>
        vscode.workspace.getConfiguration("codeAcp").update("checkAgentUpdates", false, vscode.ConfigurationTarget.Global),
      );
    }
  });
  // Checks on startup, then polls hourly so the agent picker shows new releases; `due` offers each version once per window.
  void run(offerUpdates)();
  const updateTimer = setInterval(run(offerUpdates), UPDATE_POLL_MS);

  context.subscriptions.push(
    log,
    { dispose: () => clearInterval(updateTimer) },
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
    vscode.commands.registerCommand("codeAcp.showUsage", () => SettingsPanel.show(context, runtime, manager, "usage")),
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
      "codeAcp.commitAndPush",
      run((sourceControl?: unknown) => CommitMessage.use((commit) => commit.commitAndPush(sourceControl))),
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
    vscode.commands.registerCommand("codeAcp.addProblems", run(() => provider.attachProblems("file"))),
    vscode.commands.registerCommand("codeAcp.addWorkspaceProblems", run(() => provider.attachProblems("workspace"))),
    // The "Fix with Code ACP" quick fix passes the document's uri and the diagnostics under the cursor.
    vscode.commands.registerCommand(
      "codeAcp.fixProblems",
      run((uri?: unknown, diagnostics?: unknown) =>
        uri instanceof vscode.Uri && Array.isArray(diagnostics) ? provider.fixProblems(uri, diagnostics) : Effect.void,
      ),
    ),
    vscode.languages.registerCodeActionsProvider({ scheme: "file" }, new FixProblemsActions(), {
      providedCodeActionKinds: FixProblemsActions.kinds,
    }),
    vscode.commands.registerCommand("codeAcp.addTerminalSelection", run(() => provider.attachTerminalSelection())),
    vscode.commands.registerCommand("codeAcp.addTerminalOutput", run(() => provider.attachTerminalOutput(false))),
    vscode.commands.registerCommand("codeAcp.addTerminalFailure", run(() => provider.attachTerminalOutput(true))),
    // webview/context passes the merged `data-vscode-context` of the clicked element (see src/ui/chat.tsx).
    vscode.commands.registerCommand("codeAcp.quoteSelection", (context?: { selectedText?: unknown }) => {
      if (typeof context?.selectedText === "string") {
        provider.quote(context.selectedText);
      }
    }),
    ...(
      [
        ["codeAcp.pinTab", "pin"],
        ["codeAcp.unpinTab", "unpin"],
        ["codeAcp.renameTab", "rename"],
        ["codeAcp.closeTab", "close"],
        ["codeAcp.closeOtherTabs", "closeOthers"],
        ["codeAcp.closeTabsToRight", "closeToRight"],
        ["codeAcp.forkTab", "fork"],
      ] as const
    ).map(([command, action]) =>
      // The tab's `data-vscode-context` (see TabStrip in src/ui/chat.tsx).
      vscode.commands.registerCommand(
        command,
        run((context?: { tab?: unknown }) => (typeof context?.tab === "number" ? provider.tabAction(context.tab, action) : Effect.void)),
      ),
    ),
    // Last, so services (e.g. the AgentManager event emitter) outlive everything above.
    { dispose: () => void runtime.dispose() },
  );
}

export function deactivate(): void {}
