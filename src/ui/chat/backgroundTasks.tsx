import type { BackgroundTask } from "../../chat/protocol";
import { Icon } from "../icon";
import { useL10n, type Translate } from "../l10n";
import loaderIcon from "@tabler/icons/outline/loader-2.svg";
import { openFile, post } from "./post";

/** What kind of work a task is, in words; a kind this view doesn't know goes by the task's name. */
function kindLabel(t: Translate, task: BackgroundTask): string {
  switch (task.taskType) {
    case "shell":
      return t("backgroundTasks.shell");
    case "monitor":
      return t("backgroundTasks.monitor");
    case "turn":
      return t("backgroundTasks.turn");
    default:
      return task.name;
  }
}

/** The work the agent runs in the background of the tab's session, above the composer: what it is, its output, Stop. */
export function BackgroundTasksBar({ tab, tasks }: { tab: number; tasks: readonly BackgroundTask[] }) {
  const { t } = useL10n();
  if (tasks.length === 0) return null;
  return (
    <div id="background-tasks" role="status" aria-label={t("backgroundTasks.title")}>
      {tasks.map((task) => {
        const what = task.description ?? (task.taskType === "turn" ? undefined : task.name);
        return (
          <div key={task.id} className="background-task" title={task.summary ?? what}>
            <span className="background-task-icon">
              <Icon svg={loaderIcon} />
            </span>
            <span className="background-task-kind">{kindLabel(t, task)}</span>
            {what && <span className="background-task-text">· {what}</span>}
            {task.summary && task.summary !== what && <span className="background-task-summary">{task.summary}</span>}
            <span className="spacer" />
            {task.outputFilePath && (
              <button
                className="link"
                title={t("backgroundTasks.outputTitle")}
                onClick={() => openFile({ path: task.outputFilePath! })}
              >
                {t("backgroundTasks.output")}
              </button>
            )}
            {task.canStop && (
              <button
                className="link"
                disabled={task.stopping}
                onClick={() => post({ type: "stopBackgroundTask", tab, id: task.id })}
              >
                {t(task.stopping ? "backgroundTasks.stopping" : "backgroundTasks.stop")}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
