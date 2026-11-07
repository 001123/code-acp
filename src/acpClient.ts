import * as acp from "@agentclientprotocol/sdk";
import type * as unstable from "@agentclientprotocol/sdk/unstable";
import { Deferred, Effect, Option, Schema, Scope } from "effect";
import { execa } from "execa";
import { Readable, Writable } from "node:stream";
import * as path from "node:path";
import * as vscode from "vscode";
import { AcpTrace } from "./acpTrace";
import {
  ASYNC_TASK_STOP_METHOD,
  ASYNC_TASKS_CAPABILITY_META,
  asyncTaskUpdateOf,
  type AsyncTaskUpdate,
} from "./asyncTasks";
import { t } from "./i18n";
import { makeAgentTerminals, type TerminalNotFoundError, type TerminalSnapshot } from "./agentTerminals";
import { writeFile } from "./fileChanges";
import { mcpServersFor } from "./mcpServers";
import { stopProcess } from "./processTree";
import { ExtensionCtx, messageOf, Output, thenable } from "./runtime";
import { MODE_OPTION, SessionModes } from "./sessionModes";

/** A form the agent asks the user to fill in: `elicitation/create` in form mode. */
export type FormElicitation = Extract<acp.CreateElicitationRequest, { mode: "form" }>;

/** A link the agent asks the user to open: `elicitation/create` in URL mode. */
export type UrlElicitation = Extract<acp.CreateElicitationRequest, { mode: "url" }>;

export type Elicitation = FormElicitation | UrlElicitation;

export interface AgentHandlers {
  onUpdate(notification: acp.SessionNotification): void;
  requestPermission(
    request: acp.RequestPermissionRequest,
    signal: AbortSignal,
  ): Effect.Effect<acp.RequestPermissionResponse>;
  /**
   * A form the agent asks the user to fill in, or a link to open (`elicitation/create`). Without it the client offers
   * no elicitations.
   */
  elicit?(request: Elicitation, signal: AbortSignal): Effect.Effect<acp.CreateElicitationResponse>;
  /** What the link of a URL elicitation was opened for is done (`elicitation/complete`). */
  onElicitationComplete?(elicitationId: string): void;
  /**
   * A terminal the agent runs a command in has new output, or its command exited. Without it the client
   * offers no terminals.
   */
  onTerminal?(snapshot: TerminalSnapshot): void;
  /** The agent wrote `path` through the client. */
  onFileWritten?(sessionId: string, path: string): void;
  /** Work of a session started, changed or ended in the background. Without it the client offers no async tasks. */
  onAsyncTask?(sessionId: string, update: AsyncTaskUpdate): void;
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
  /** Needs `sessionCapabilities.fork`; a new session that starts with a copy of this one's history. */
  forkSession(sessionId: string, cwd: string): Effect.Effect<unstable.ForkSessionResponse, RequestError>;
  /** Needs `sessionCapabilities.close`; frees the session's resources on the agent. */
  closeSession(sessionId: string): Effect.Effect<void, RequestError>;
  /** Needs `sessionCapabilities.delete`; removes a session from `session/list`. */
  deleteSession(sessionId: string): Effect.Effect<void, RequestError>;
  prompt(sessionId: string, prompt: Array<acp.ContentBlock>): Effect.Effect<acp.PromptResponse, RequestError>;
  cancel(sessionId: string): Effect.Effect<void, RequestError>;
  setConfigOption(
    sessionId: string,
    configId: string,
    value: string,
  ): Effect.Effect<acp.SetSessionConfigOptionResponse, RequestError>;
  authenticate(methodId: string): Effect.Effect<acp.AuthenticateResponse, RequestError>;
  /** Needs `auth.logout`; new sessions need a login afterwards, and sessions already running may stop working. */
  readonly logout: Effect.Effect<void, RequestError>;
  /** Stops the command of one of the agent's terminals; the agent still gets its output and exit status. */
  killTerminal(sessionId: string, terminalId: string): Effect.Effect<void, TerminalNotFoundError>;
  /** Stops a background task of the session ("onAsyncTask"); the prompt turn goes on. */
  stopAsyncTask(sessionId: string, asyncTaskId: string): Effect.Effect<void, RequestError>;
}

/** The same stream, with the async task updates taken off it and given to `onAsyncTask`. */
function takeAsyncTasks<M>(
  stream: { readable: ReadableStream<M>; writable: WritableStream<M> },
  onAsyncTask: (sessionId: string, update: AsyncTaskUpdate) => void,
) {
  return {
    readable: stream.readable.pipeThrough(
      new TransformStream<M, M>({
        transform(message, controller) {
          const task = asyncTaskUpdateOf(message);
          if (task === undefined) {
            controller.enqueue(message);
          } else if (task !== "drop") {
            onAsyncTask(task.sessionId, task.update);
          }
        },
      }),
    ),
    writable: stream.writable,
  };
}

/** Whether the agent can fork sessions; session/fork is unstable, so the stable types leave it out. */
export function canFork(agent: AcpAgent): boolean {
  const caps: unstable.SessionCapabilities | null | undefined =
    agent.initializeResponse.agentCapabilities?.sessionCapabilities;
  return !!caps?.fork;
}

/** Whether the agent can log the user out. */
export function canLogout(agent: AcpAgent): boolean {
  return !!agent.initializeResponse.agentCapabilities?.auth?.logout;
}

/** The part of the extension's package.json sent as `clientInfo`. */
const PackageVersion = Schema.Struct({ version: Schema.String });

/** How long the agent may take to answer `initialize`; a first `uvx` run downloads its packages first. */
const INIT_TIMEOUT_SECONDS = 120;

/** How long a failed `initialize` waits for the process exit that may explain it. */
const EXIT_GRACE_MS = 1000;

function isAuthRequired(error: unknown): boolean {
  return error instanceof acp.RequestError && error.code === acp.RequestError.authRequired().code;
}

/** Spawns the agent and runs the ACP initialize handshake; the process is killed when the Scope closes. */
export const spawnAgent = Effect.fn("spawnAgent")(function* (
  agentCommand: AgentCommand,
  handlers: AgentHandlers,
): Effect.fn.Return<AcpAgent, AgentStartError | RequestError, Scope.Scope | Output | ExtensionCtx | AcpTrace> {
  const output = yield* Output;
  const trace = yield* AcpTrace;
  const { version } = Schema.decodeUnknownOption(PackageVersion)((yield* ExtensionCtx).extension.packageJSON).pipe(
    Option.getOrElse(() => ({ version: "0.0.0" })),
  );
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  const exited = yield* Deferred.make<AgentExit>();
  /** The folder of each session, for the commands it runs in client terminals. */
  const sessionCwds = new Map<string, string>();
  const terminals = yield* makeAgentTerminals(
    (snapshot) => handlers.onTerminal?.(snapshot),
    (sessionId) => sessionCwds.get(sessionId),
  );
  const remember = (sessionId: string, cwd: string) => Effect.sync(() => void sessionCwds.set(sessionId, cwd));
  const modes = new SessionModes();
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
      const traced = trace.tap(
        acp.ndJsonStream(
          Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
          Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
        ),
        `${path.basename(command)}#${child.pid ?? "?"}`,
      );
      const { onAsyncTask } = handlers;
      const stream = onAsyncTask ? takeAsyncTasks(traced, onAsyncTask) : traced;
      const connection = acp
        .client({ name: "kd-code" })
        .onNotification(acp.methods.client.session.update, ({ params }) => handlers.onUpdate(modes.translate(params)))
        .onRequest(acp.methods.client.session.requestPermission, ({ params, signal }) =>
          runPromise(handlers.requestPermission(params, signal)),
        )
        .onRequest(acp.methods.client.elicitation.create, ({ params, signal }) =>
          // A future mode is not shown to the user.
          handlers.elicit && (params.mode === "form" || params.mode === "url")
            ? runPromise(handlers.elicit(params as Elicitation, signal))
            : ({ action: "cancel" } satisfies acp.CreateElicitationResponse),
        )
        .onNotification(acp.methods.client.elicitation.complete, ({ params }) =>
          handlers.onElicitationComplete?.(params.elicitationId),
        )
        .onRequest(acp.methods.client.fs.readTextFile, ({ params }) => runPromise(readTextFile(params)))
        .onRequest(acp.methods.client.fs.writeTextFile, ({ params }) =>
          runPromise(
            writeFile(params.path, params.content).pipe(
              Effect.map(() => {
                handlers.onFileWritten?.(params.sessionId, params.path);
                return {};
              }),
            ),
          ),
        )
        .onRequest(acp.methods.client.terminal.create, ({ params }) => runPromise(terminals.create(params)))
        .onRequest(acp.methods.client.terminal.output, ({ params }) => runPromise(terminals.output(params)))
        .onRequest(acp.methods.client.terminal.waitForExit, ({ params }) => runPromise(terminals.waitForExit(params)))
        .onRequest(acp.methods.client.terminal.kill, ({ params }) => runPromise(terminals.kill(params)))
        .onRequest(acp.methods.client.terminal.release, ({ params }) => runPromise(terminals.release(params)))
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
      clientInfo: { name: "kd-code", version },
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: handlers.onTerminal !== undefined,
        auth: { terminal: true },
        session: { notices: {}, compaction: {} },
        ...(handlers.elicit ? { elicitation: { form: {}, url: {} } } : {}),
        ...(handlers.onAsyncTask ? { _meta: ASYNC_TASKS_CAPABILITY_META } : {}),
      },
    }),
  ).pipe(
    // The SDK fails the pending request as soon as stdout closes, a moment before the exit is seen; an exit
    // (or a failed spawn) says more than "connection closed".
    Effect.catchTag("AgentRequestError", (err) =>
      exitedEarly.pipe(Effect.timeoutOrElse({ duration: `${EXIT_GRACE_MS} millis`, orElse: () => Effect.fail(err) })),
    ),
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
        Effect.tap((res) => remember(res.sessionId, cwd)),
        Effect.map((res) => modes.adopt(res.sessionId, res)),
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
        Effect.tap(() => remember(sessionId, cwd)),
        Effect.map((res) => modes.adopt(sessionId, res)),
      ),
    resumeSession: (sessionId, cwd) =>
      mcpServers.pipe(
        Effect.flatMap((mcpServers) =>
          request("session/resume", (agent) =>
            agent.request(acp.methods.agent.session.resume, { sessionId, cwd, mcpServers }),
          ),
        ),
        Effect.tap(() => remember(sessionId, cwd)),
        Effect.map((res) => modes.adopt(sessionId, res)),
      ),
    forkSession: (sessionId, cwd) =>
      mcpServers.pipe(
        Effect.flatMap((mcpServers) =>
          request("session/fork", (agent) =>
            agent.request<unstable.ForkSessionResponse, unstable.ForkSessionRequest>("session/fork", {
              sessionId,
              cwd,
              mcpServers,
            }),
          ),
        ),
        Effect.tap((res) => remember(res.sessionId, cwd)),
        Effect.map((res) => modes.adopt(res.sessionId, res)),
      ),
    closeSession: (sessionId) =>
      request("session/close", (agent) => agent.request(acp.methods.agent.session.close, { sessionId })).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            sessionCwds.delete(sessionId);
            modes.forget(sessionId);
          }),
        ),
        Effect.asVoid,
      ),
    deleteSession: (sessionId) =>
      request("session/delete", (agent) => agent.request(acp.methods.agent.session.delete, { sessionId })).pipe(
        Effect.asVoid,
      ),
    prompt: (sessionId, prompt) =>
      request("session/prompt", (agent) => agent.request(acp.methods.agent.session.prompt, { sessionId, prompt })),
    cancel: (sessionId) =>
      request("session/cancel", (agent) => agent.notify(acp.methods.agent.session.cancel, { sessionId })),
    setConfigOption: (sessionId, configId, value) =>
      configId === MODE_OPTION
        ? request("session/set_mode", (agent) =>
            agent.request(acp.methods.agent.session.setMode, { sessionId, modeId: value }),
          ).pipe(Effect.map(() => ({ configOptions: modes.select(sessionId, value) })))
        : request("session/set_config_option", (agent) =>
            agent.request(acp.methods.agent.session.setConfigOption, { sessionId, configId, value }),
          ),
    authenticate: (methodId) =>
      request("authenticate", (agent) => agent.request(acp.methods.agent.authenticate, { methodId })),
    logout: request("logout", (agent) => agent.request(acp.methods.agent.logout, {})).pipe(Effect.asVoid),
    killTerminal: (sessionId, terminalId) => terminals.kill({ sessionId, terminalId }).pipe(Effect.asVoid),
    stopAsyncTask: (sessionId, asyncTaskId) =>
      request(ASYNC_TASK_STOP_METHOD, (agent) =>
        agent.request<unknown, { sessionId: string; asyncTaskId: string }>(ASYNC_TASK_STOP_METHOD, {
          sessionId,
          asyncTaskId,
        }),
      ).pipe(Effect.asVoid),
  };
});

/** How long removing a throwaway session may take before it is left to the agent. */
const DISCARD_TIMEOUT = "5 seconds";

/**
 * A session for the extension's own use (commit messages, probes), removed from `session/list` (or at least closed)
 * when the Scope closes, so it never shows in History.
 */
export const throwawaySession = (
  agent: AcpAgent,
  cwd: string,
): Effect.Effect<acp.NewSessionResponse, RequestError, Scope.Scope> =>
  Effect.acquireRelease(agent.newSession(cwd), ({ sessionId }) => {
    const capabilities = agent.initializeResponse.agentCapabilities?.sessionCapabilities;
    const discard = capabilities?.delete
      ? agent.deleteSession(sessionId)
      : capabilities?.close
        ? agent.closeSession(sessionId)
        : Effect.void;
    return discard.pipe(Effect.timeout(DISCARD_TIMEOUT), Effect.ignore);
  });

const readTextFile = Effect.fn("readTextFile")(function* (params: acp.ReadTextFileRequest) {
  const uri = vscode.Uri.file(params.path);
  // The editor buffer shows the agent unsaved changes. Any other file stays closed: opening it would wake language servers.
  const open = vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === uri.toString());
  let content = open
    ? open.getText()
    : yield* thenable(() => vscode.workspace.fs.readFile(uri)).pipe(
        Effect.flatMap((bytes) => thenable(() => vscode.workspace.decode(bytes, { uri }))),
      );
  if (params.line != null || params.limit != null) {
    const lines = content.split("\n");
    const start = Math.max(0, (params.line ?? 1) - 1);
    const end = params.limit != null ? start + params.limit : undefined;
    content = lines.slice(start, end).join("\n");
  }
  return { content } satisfies acp.ReadTextFileResponse;
});
