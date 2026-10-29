import * as acp from "@agentclientprotocol/sdk";
import { Deferred, Effect, Schema, Scope } from "effect";
import { spawn } from "node:child_process";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import * as vscode from "vscode";
import { t } from "./i18n";
import { messageOf, Output, thenable } from "./runtime";

export interface AgentHandlers {
  onUpdate(notification: acp.SessionNotification): void;
  requestPermission(
    request: acp.RequestPermissionRequest,
    signal: AbortSignal,
  ): Effect.Effect<acp.RequestPermissionResponse>;
}

export interface AgentCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
}

export interface AgentExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  /** Set when the process could not be started at all. */
  readonly spawnError?: string;
}

export class AgentStartError extends Schema.TaggedError<AgentStartError>()("AgentStartError", {
  message: Schema.String,
}) {}

/** The agent answered a request with "auth required"; the user has to log in first. */
export class AuthRequiredError extends Schema.TaggedError<AuthRequiredError>()("AuthRequiredError", {
  message: Schema.String,
}) {}

export class AgentRequestError extends Schema.TaggedError<AgentRequestError>()("AgentRequestError", {
  method: Schema.String,
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

type RequestError = AuthRequiredError | AgentRequestError;

/** A running ACP agent process. Its lifetime is the Scope it was spawned in. */
export interface AcpAgent {
  readonly initializeResponse: acp.InitializeResponse;
  readonly authMethods: ReadonlyArray<acp.AuthMethod>;
  /** Completes when the process exits on its own (not when its Scope closes). */
  readonly exited: Effect.Effect<AgentExit>;
  newSession(cwd: string): Effect.Effect<acp.NewSessionResponse, RequestError>;
  /** Needs `sessionCapabilities.list`. */
  listSessions(cwd: string, cursor?: string): Effect.Effect<acp.ListSessionsResponse, RequestError>;
  /** Needs `loadSession`; the agent replays the history as session updates before answering. */
  loadSession(sessionId: string, cwd: string): Effect.Effect<acp.LoadSessionResponse, RequestError>;
  /** Needs `sessionCapabilities.resume`; continues a session without replaying its history. */
  resumeSession(sessionId: string, cwd: string): Effect.Effect<acp.ResumeSessionResponse, RequestError>;
  /** Needs `sessionCapabilities.close`; frees the session's resources on the agent. */
  closeSession(sessionId: string): Effect.Effect<void, RequestError>;
  prompt(sessionId: string, prompt: Array<acp.ContentBlock>): Effect.Effect<acp.PromptResponse, RequestError>;
  cancel(sessionId: string): Effect.Effect<void, RequestError>;
  setConfigOption(
    sessionId: string,
    configId: string,
    value: string,
  ): Effect.Effect<acp.SetSessionConfigOptionResponse, RequestError>;
  authenticate(methodId: string): Effect.Effect<acp.AuthenticateResponse, RequestError>;
}

function isAuthRequired(error: unknown): boolean {
  return error instanceof acp.RequestError && error.code === acp.RequestError.authRequired().code;
}

/** Spawns the agent and runs the ACP initialize handshake; the process is killed when the Scope closes. */
export const spawnAgent = Effect.fn("spawnAgent")(function* (
  agentCommand: AgentCommand,
  handlers: AgentHandlers,
): Effect.fn.Return<AcpAgent, AgentStartError | RequestError, Scope.Scope | Output> {
  const output = yield* Output;
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  const exited = yield* Deferred.make<AgentExit>();
  const { command, args, env } = agentCommand;
  yield* Effect.logInfo(`[agent] spawn ${command} ${args.join(" ")}`);

  const connection = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const child = spawn(command, [...args], {
        env: { ...process.env, ...env },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const stream = acp.ndJsonStream(
        Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
      );
      const connection = acp
        .client({ name: "code-acp" })
        .onNotification(acp.methods.client.session.update, ({ params }) => handlers.onUpdate(params))
        .onRequest(acp.methods.client.session.requestPermission, ({ params, signal }) =>
          runPromise(handlers.requestPermission(params, signal)),
        )
        .onRequest(acp.methods.client.fs.readTextFile, ({ params }) => runPromise(readTextFile(params)))
        .onRequest(acp.methods.client.fs.writeTextFile, ({ params }) =>
          runPromise(writeTextFile(params).pipe(Effect.as({}))),
        )
        .connect(stream);
      const exit = (info: AgentExit) => {
        connection.close();
        Deferred.doneUnsafe(exited, Effect.succeed(info));
      };
      child.stderr.on("data", (chunk: Buffer) => output.append(chunk.toString()));
      // A failed spawn (e.g. command not found) emits "error" and no "exit".
      child.on("error", (err) => {
        output.appendLine(`[agent] error: ${err.message}`);
        exit({ code: null, signal: null, spawnError: err.message });
      });
      child.on("exit", (code, signal) => {
        output.appendLine(`[agent] exited code=${code} signal=${signal}`);
        exit({ code, signal });
      });
      return { child, connection };
    }),
    ({ child, connection }) =>
      Effect.sync(() => {
        connection.close();
        child.kill();
      }),
  ).pipe(Effect.map(({ connection }) => connection));

  const request = <A>(method: string, send: (agent: acp.ClientContext) => Promise<A>): Effect.Effect<A, RequestError> =>
    Effect.tryPromise({
      try: () => send(connection.agent),
      catch: (cause) =>
        isAuthRequired(cause)
          ? new AuthRequiredError({ message: messageOf(cause) })
          : new AgentRequestError({ method, message: messageOf(cause), cause }),
    });

  const exitedEarly = Deferred.await(exited).pipe(
    Effect.flatMap((info) =>
      Effect.fail(
        new AgentStartError({
          message: info.spawnError
            ? t("agent.spawnFailed", info.spawnError)
            : t("agent.exitedEarly", info.code ?? info.signal),
        }),
      ),
    ),
  );
  const initializeResponse = yield* request("initialize", (agent) =>
    agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientInfo: { name: "code-acp", version: "0.0.1" },
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: false,
        auth: { terminal: true },
      },
    }),
  ).pipe(Effect.raceFirst(exitedEarly));
  yield* Effect.logInfo(`[agent] initialized: ${JSON.stringify(initializeResponse.agentInfo ?? {})}`);

  return {
    initializeResponse,
    authMethods: initializeResponse.authMethods ?? [],
    exited: Deferred.await(exited),
    newSession: (cwd) =>
      request("session/new", (agent) => agent.request(acp.methods.agent.session.new, { cwd, mcpServers: [] })),
    listSessions: (cwd, cursor) =>
      request("session/list", (agent) => agent.request(acp.methods.agent.session.list, { cwd, cursor })),
    loadSession: (sessionId, cwd) =>
      request("session/load", (agent) =>
        agent.request(acp.methods.agent.session.load, { sessionId, cwd, mcpServers: [] }),
      ),
    resumeSession: (sessionId, cwd) =>
      request("session/resume", (agent) =>
        agent.request(acp.methods.agent.session.resume, { sessionId, cwd, mcpServers: [] }),
      ),
    closeSession: (sessionId) =>
      request("session/close", (agent) => agent.request(acp.methods.agent.session.close, { sessionId })).pipe(
        Effect.asVoid,
      ),
    prompt: (sessionId, prompt) =>
      request("session/prompt", (agent) => agent.request(acp.methods.agent.session.prompt, { sessionId, prompt })),
    cancel: (sessionId) =>
      request("session/cancel", (agent) => agent.notify(acp.methods.agent.session.cancel, { sessionId })),
    setConfigOption: (sessionId, configId, value) =>
      request("session/set_config_option", (agent) =>
        agent.request(acp.methods.agent.session.setConfigOption, { sessionId, configId, value }),
      ),
    authenticate: (methodId) =>
      request("authenticate", (agent) => agent.request(acp.methods.agent.authenticate, { methodId })),
  };
});

const readTextFile = Effect.fn("readTextFile")(function* (params: acp.ReadTextFileRequest) {
  // openTextDocument returns the editor buffer, so unsaved changes are visible to the agent.
  const doc = yield* thenable(() => vscode.workspace.openTextDocument(vscode.Uri.file(params.path)));
  let content = doc.getText();
  if (params.line != null || params.limit != null) {
    const lines = content.split("\n");
    const start = Math.max(0, (params.line ?? 1) - 1);
    const end = params.limit != null ? start + params.limit : undefined;
    content = lines.slice(start, end).join("\n");
  }
  return { content } satisfies acp.ReadTextFileResponse;
});

const writeTextFile = Effect.fn("writeTextFile")(function* (params: acp.WriteTextFileRequest) {
  const uri = vscode.Uri.file(params.path);
  const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath);
  if (open) {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(0, 0, open.lineCount, 0), params.content);
    yield* thenable(() => vscode.workspace.applyEdit(edit));
    yield* thenable(() => open.save());
    return;
  }
  yield* thenable(() => vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(params.path))));
  yield* thenable(() => vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(params.content)));
});
