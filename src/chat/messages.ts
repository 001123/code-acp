import { Effect, Option } from "effect";
import * as vscode from "vscode";
import { CommitMessage, type CommitMessageError } from "../commitMessage";
import { Completions } from "../completions";
import { Problems } from "../problems";
import { thenable, type AppServices, type VscodeError } from "../runtime";
import { agentOptions, modelOption, type AgentOptions, type Wanted } from "../sessionOptions";
import { TerminalContext } from "../terminalContext";
import { imageToTempFile, type AttachmentQueue } from "./attachments";
import type { Permissions } from "./permissions";
import type { ViewMessage } from "./protocol";
import type { Tab } from "./tabs";

/** What the messages outside the tabs' conversations need from the chat view. */
export interface ViewMessagesHost {
  post(message: unknown): void;
  readonly attachments: AttachmentQueue;
  readonly permissions: Permissions<Tab>;
  /** The tabs' sessions, whose options can be read without starting the agent again. */
  liveTabs(): ReadonlyArray<Tab>;
  usualOptions(agentId: string): Wanted | undefined;
  openFile(file: string, line: number | undefined): Effect.Effect<void, VscodeError, AppServices>;
}

const runCommand = (command: string, ...args: ReadonlyArray<unknown>) =>
  thenable(() => vscode.commands.executeCommand(command, ...args));

const updateSetting = (key: string, value: boolean) =>
  thenable(() => vscode.workspace.getConfiguration("codeAcp").update(key, value, vscode.ConfigurationTarget.Global));

/** Answers the webview's messages that don't touch a tab's conversation. */
export class ViewMessages {
  constructor(private readonly host: ViewMessagesHost) {}

  /** What the agent offers: from a session already on that model, else from a throwaway one on the model asked for or its usual one. */
  private attemptOptions(agentId: string, model: string): Effect.Effect<AgentOptions, CommitMessageError, CommitMessage> {
    const live = this.host.liveTabs().find((tab) => tab.running?.agentId === agentId && model !== "" && modelOption(tab.configOptions)?.currentValue === model);
    return live
      ? Effect.succeed(agentOptions(live.configOptions))
      : CommitMessage.use((commit) => commit.options(agentId, model || (this.host.usualOptions(agentId)?.model ?? "")));
  }

  readonly handle = Effect.fn("ViewMessages.handle")(function* (this: ViewMessages, msg: ViewMessage) {
    switch (msg.type) {
      case "selectAgent":
        yield* runCommand("codeAcp.selectAgent");
        break;
      case "manageAgents":
        yield* runCommand("codeAcp.manageAgents");
        break;
      case "showTrace":
        yield* runCommand("codeAcp.showTrace");
        break;
      case "showUsage":
        yield* runCommand("codeAcp.showUsage");
        break;
      case "openSettings":
        yield* runCommand("codeAcp.openSettings");
        break;
      case "permission":
        this.host.permissions.answer(msg.id, msg.optionId);
        break;
      case "elicitation":
        this.host.permissions.answerElicitation(msg.id, msg.response);
        break;
      case "openFile":
        yield* this.host.openFile(msg.path, msg.line);
        break;
      case "openImage": {
        const file = yield* imageToTempFile(msg.src, msg.name);
        if (file) {
          yield* runCommand("vscode.open", vscode.Uri.file(file));
          yield* runCommand("workbench.action.moveEditorToNewWindow");
        }
        break;
      }
      case "searchFiles": {
        const completions = yield* Completions;
        // A failed search offers nothing rather than an error in the chat.
        const files = yield* completions.files(msg.query).pipe(
          Effect.tapError((err) => Effect.logWarning(`File search failed: ${err.message}`)),
          Effect.orElseSucceed(() => []),
        );
        const terminals = yield* (yield* TerminalContext).suggestions(msg.query);
        const problems = yield* (yield* Problems).suggestions(msg.query);
        this.host.post({ type: "files", id: msg.id, files, terminals, problems });
        break;
      }
      case "attachProblems": {
        const attachment = yield* (yield* Problems).attachment(msg.scope);
        if (Option.isSome(attachment)) {
          this.host.attachments.add([attachment.value]);
        }
        break;
      }
      case "attachTerminal": {
        const attachment = yield* (yield* TerminalContext).command(msg.id);
        if (Option.isSome(attachment)) {
          this.host.attachments.add([attachment.value]);
        }
        break;
      }
      case "listSkills":
        this.host.post({ type: "skills", skills: yield* (yield* Completions).skills });
        break;
      case "loadAttemptOptions": {
        const { agentId, model } = msg;
        const result = yield* this.attemptOptions(agentId, model).pipe(
          Effect.map((options) => ({ options })),
          Effect.catchTag("CommitMessageError", (err) => Effect.succeed({ error: err.message })),
        );
        this.host.post({ type: "attemptOptions", agentId, model, ...result });
        break;
      }
      case "setFollowAgent":
        yield* updateSetting("followAgent", msg.enabled);
        break;
      case "setAutoScroll":
        yield* updateSetting("autoScroll", msg.enabled);
        break;
      default:
        msg satisfies never;
    }
  });
}
