import { Option, Schema } from "effect";

/**
 * Work an agent runs in the background of a session, apart from its prompt turns: a shell command sent to the
 * background, a monitor, or a turn the agent started on its own. It comes from the `asyncTasks` capability of the
 * JetBrains AIR extension to ACP, which claude-agent-acp and codex-acp speak. ACP v1 has no such updates, so the SDK
 * would reject them: the client takes them off the stream before it does.
 */
export const ASYNC_TASKS_CAPABILITY_META = {
  jetbrains: { air: { version: 1, capabilities: ["asyncTasks"] } },
} as const;

/** Stops one background task without cancelling the prompt turn. */
export const ASYNC_TASK_STOP_METHOD = "_session/async_task/stop";

const AsyncTaskState = Schema.Literals(["running", "paused", "completed", "failed", "stopped"]);
export type AsyncTaskState = typeof AsyncTaskState.Type;

const AsyncTaskSpawned = Schema.Struct({
  sessionUpdate: Schema.Literal("async_task_spawned"),
  asyncTaskId: Schema.String,
  name: Schema.String,
  taskType: Schema.String,
  description: Schema.optional(Schema.String),
  canStop: Schema.optional(Schema.Boolean),
  outputFilePath: Schema.optional(Schema.String),
  toolCallId: Schema.optional(Schema.String),
});

const AsyncTaskProgress = Schema.Struct({
  sessionUpdate: Schema.Literal("async_task_progress"),
  asyncTaskId: Schema.String,
  description: Schema.optional(Schema.String),
  summary: Schema.optional(Schema.String),
  lastToolName: Schema.optional(Schema.String),
  outputFilePath: Schema.optional(Schema.String),
  toolCallId: Schema.optional(Schema.String),
});

const AsyncTaskStateUpdate = Schema.Struct({
  sessionUpdate: Schema.Literal("async_task_state_update"),
  asyncTaskId: Schema.String,
  state: AsyncTaskState,
  summary: Schema.optional(Schema.String),
  outputFilePath: Schema.optional(Schema.String),
  toolCallId: Schema.optional(Schema.String),
});

export const AsyncTaskUpdate = Schema.Union([AsyncTaskSpawned, AsyncTaskProgress, AsyncTaskStateUpdate]);
export type AsyncTaskUpdate = typeof AsyncTaskUpdate.Type;

/** A `session/update` notification that carries an async task update. */
const AsyncTaskNotification = Schema.Struct({
  method: Schema.Literal("session/update"),
  params: Schema.Struct({ sessionId: Schema.String, update: AsyncTaskUpdate }),
});

/** Any `session/update` of the extension, also one of a later version this client can't read. */
const AnyAsyncTaskNotification = Schema.Struct({
  method: Schema.Literal("session/update"),
  params: Schema.Struct({
    update: Schema.Struct({ sessionUpdate: Schema.TemplateLiteral(["async_task_", Schema.String]) }),
  }),
});

const decodeNotification = Schema.decodeUnknownOption(AsyncTaskNotification);
const isAnyAsyncTaskNotification = Schema.is(AnyAsyncTaskNotification);

/**
 * What `message` is to the async task extension: an update to pass on, one to drop (the SDK would fail on it), or
 * none of its messages.
 */
export function asyncTaskUpdateOf(
  message: unknown,
): { sessionId: string; update: AsyncTaskUpdate } | "drop" | undefined {
  const decoded = Option.getOrUndefined(decodeNotification(message));
  if (decoded) return decoded.params;
  return isAnyAsyncTaskNotification(message) ? "drop" : undefined;
}

/** Whether a task in `state` is over. */
export const isTerminalState = (state: AsyncTaskState): boolean => state !== "running" && state !== "paused";
