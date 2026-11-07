import { Effect } from "effect";
import { isTerminalState, type AsyncTaskUpdate } from "../asyncTasks";
import type { BackgroundTask } from "./protocol";
import type { Tab } from "./tabs";

export interface BackgroundTasksHost {
  postTab(tab: Tab, message: Record<string, unknown>): void;
  /** A tab's tasks changed: the status bar and the sidebar count them. */
  changed(): void;
}

/** The work agents run in the background of chat tabs' sessions, by tab, for as long as it runs. */
export class TabBackgroundTasks {
  /** By tab: the session the tasks belong to, and its running tasks by id. */
  private readonly byTab = new WeakMap<Tab, { sessionId: string; tasks: Map<string, BackgroundTask> }>();

  constructor(private readonly host: BackgroundTasksHost) {}

  /** The running tasks of the tab's session; none once the tab shows another session, or none. */
  of(tab: Tab): BackgroundTask[] {
    const entry = this.byTab.get(tab);
    return entry && tab.sessionId === entry.sessionId && tab.running ? [...entry.tasks.values()] : [];
  }

  /** Whether the tab's session runs anything in the background. */
  has(tab: Tab): boolean {
    return this.of(tab).length > 0;
  }

  onUpdate(tab: Tab, sessionId: string, update: AsyncTaskUpdate): void {
    let entry = this.byTab.get(tab);
    if (entry?.sessionId !== sessionId) {
      entry = { sessionId, tasks: new Map() };
      this.byTab.set(tab, entry);
    }
    const { tasks } = entry;
    const known = tasks.get(update.asyncTaskId);
    switch (update.sessionUpdate) {
      case "async_task_spawned":
        tasks.set(update.asyncTaskId, {
          id: update.asyncTaskId,
          name: update.name,
          taskType: update.taskType,
          description: update.description || undefined,
          outputFilePath: update.outputFilePath,
          toolCallId: update.toolCallId,
          canStop: update.canStop ?? false,
        });
        break;
      case "async_task_progress":
        if (!known) return;
        tasks.set(update.asyncTaskId, {
          ...known,
          description: update.description || known.description,
          summary: update.summary || known.summary,
          outputFilePath: update.outputFilePath ?? known.outputFilePath,
          toolCallId: update.toolCallId ?? known.toolCallId,
        });
        break;
      case "async_task_state_update":
        if (isTerminalState(update.state)) {
          if (!tasks.delete(update.asyncTaskId)) return;
        } else if (known) {
          tasks.set(update.asyncTaskId, { ...known, summary: update.summary || known.summary });
        } else {
          return;
        }
        break;
    }
    this.post(tab);
    this.host.changed();
  }

  /** Shows the tab's tasks; also after the tab moved to another session, to clear them. */
  post(tab: Tab): void {
    this.host.postTab(tab, { type: "backgroundTasks", tasks: this.of(tab) });
  }

  /** Asks the agent to stop task `id`; it ends when the agent reports so. */
  readonly stop = Effect.fn("TabBackgroundTasks.stop")(function* (this: TabBackgroundTasks, tab: Tab, id: string) {
    const task = this.byTab.get(tab)?.tasks.get(id);
    const { running, sessionId } = tab;
    if (!task?.canStop || !running || !sessionId || !this.has(tab)) {
      return;
    }
    this.byTab.get(tab)?.tasks.set(id, { ...task, stopping: true });
    this.post(tab);
    yield* running.agent.stopAsyncTask(sessionId, id).pipe(
      Effect.tapError(() =>
        Effect.sync(() => {
          const now = this.byTab.get(tab)?.tasks.get(id);
          if (now) {
            this.byTab.get(tab)?.tasks.set(id, { ...now, stopping: false });
            this.post(tab);
          }
        }),
      ),
    );
  });
}
