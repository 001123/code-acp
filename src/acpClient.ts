import * as acp from "@agentclientprotocol/sdk";
import { Deferred, Effect, Option, Schema, Scope } from "effect";
import { execa } from "execa";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import * as vscode from "vscode";
import { t } from "./i18n";
import { mcpServersFor } from "./mcpServers";
import { ExtensionCtx, messageOf, Output, thenable } from "./runtime";

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

/** How long a stopped agent gets to exit on SIGTERM before it is killed. */
const KILL_GRACE_MS = 3000;

/** The part of the extension's package.json sent as `clientInfo`. */
const PackageVersion = Schema.Struct({ version: Schema.String });

/**
 * Stops the agent and whatever it started. On POSIX it leads its own process group (`detached`), so wrappers
 * such as `uvx` or `npx` don't leave their child running, and SIGKILL follows if it ignores SIGTERM. Windows
 * has no signals to wait on: `taskkill /T` ends the whole tree, cmd.exe shims included.
 */
function stopProcess(child: { readonly pid?: number | undefined; kill(): boolean }, ended: () => boolean): void {
  if (ended() || child.pid === undefined) {
    return;
  }
  const pid = child.pid;
  if (process.platform === "win32") {
    void execa("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", reject: false }).then((result) => {
      if (result.failed) {
        child.kill();
      }
    });
    return;
  }
  const signal = (name: NodeJS.Signals) => {
    try {
      process.kill(-pid, name);
    } catch {
      // Already gone.
    }
  };
  signal("SIGTERM");
  setTimeout(() => {
    if (!ended()) {
      signal("SIGKILL");
    }
  }, KILL_GRACE_MS).unref();
}

/** How long the agent may take to answer `initialize`; a first `uvx` run downloads its packages first. */
const INIT_TIMEOUT_SECONDS = 120;

function isAuthRequired(error: unknown): boolean {
  return error instanceof acp.RequestError && error.code === acp.RequestError.authRequired().code;
}

/** Spawns the agent and runs the ACP initialize handshake; the process is killed when the Scope closes. */
export const spawnAgent = Effect.fn("spawnAgent")(function* (
  agentCommand: AgentCommand,
  handlers: AgentHandlers,
): Effect.fn.Return<AcpAgent, AgentStartError | RequestError, Scope.Scope | Output | ExtensionCtx> {
  const output = yield* Output;
  const { version } = Schema.decodeUnknownOption(PackageVersion)((yield* ExtensionCtx).extension.packageJSON).pipe(
    Option.getOrElse(() => ({ version: "0.0.0" })),
  );
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  const exited = yield* Deferred.make<AgentExit>();
  const { command, args, env } = agentCommand;
  yield* Effect.logInfo(`[agent] spawn ${command} ${args.join(" ")}`);

  const connection = yield* Effect.acquireRelease(
    Effect.sync(() => {
      // execa: on Windows, `npx`-style commands are .cmd shims that need cmd.exe and escaped arguments.
      const child = execa(command, [...args], {
        env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
        // A long-lived process: its output is streamed, never collected, and ending is not a failure.
        buffer: false,
        reject: false,
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
      let ended = false;
      // With `reject: false` this settles once, on exit or on a failed spawn (e.g. command not found).
      void child.then((result) => {
        ended = true;
        const code = result.exitCode ?? null;
        const signal = result.signal ?? null;
        if (result.failed && code === null && signal === null) {
          const message = result.originalMessage || result.shortMessage;
          output.appendLine(`[agent] error: ${message}`);
          exit({ code, signal, spawnError: message });
        } else {
          output.appendLine(`[agent] exited code=${code} signal=${signal}`);
          exit({ code, signal });
        }
      });
      return { child, connection, ended: () => ended };
    }),
    ({ child, connection, ended }) =>
      Effect.sync(() => {
        connection.close();
        stopProcess(child, ended);
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
      clientInfo: { name: "code-acp", version },
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: false,
        auth: { terminal: true },
      },
    }),
  ).pipe(
    Effect.raceFirst(exitedEarly),
    // A hung agent would otherwise keep its tabs on "starting" forever.
    Effect.timeoutOrElse({
      duration: `${INIT_TIMEOUT_SECONDS} seconds`,
      orElse: () => Effect.fail(new AgentStartError({ message: t("agent.initTimeout", INIT_TIMEOUT_SECONDS) })),
    }),
  );
  yield* Effect.logInfo(`[agent] initialized: ${JSON.stringify(initializeResponse.agentInfo ?? {})}`);
  // Read per session, so settings changes apply without restarting the agent.
  const mcpServers = mcpServersFor(initializeResponse.agentCapabilities?.mcpCapabilities);

  return {
    initializeResponse,
    authMethods: initializeResponse.authMethods ?? [],
    exited: Deferred.await(exited),
    newSession: (cwd) =>
      mcpServers.pipe(
        Effect.flatMap((mcpServers) =>
          request("session/new", (agent) => agent.request(acp.methods.agent.session.new, { cwd, mcpServers })),
        ),
      ),
    listSessions: (cwd, cursor) =>
      request("session/list", (agent) => agent.request(acp.methods.agent.session.list, { cwd, cursor })),
    loadSession: (sessionId, cwd) =>
      mcpServers.pipe(
        Effect.flatMap((mcpServers) =>
          request("session/load", (agent) =>
            agent.request(acp.methods.agent.session.load, { sessionId, cwd, mcpServers }),
          ),
        ),
      ),
    resumeSession: (sessionId, cwd) =>
      mcpServers.pipe(
        Effect.flatMap((mcpServers) =>
          request("session/resume", (agent) =>
            agent.request(acp.methods.agent.session.resume, { sessionId, cwd, mcpServers }),
          ),
        ),
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
