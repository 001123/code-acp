import type { TabGroupInfo, TabInfo } from "../../chat/protocol";
import { Icon } from "../icon";
import { useL10n } from "../l10n";
import refreshIcon from "@tabler/icons/outline/refresh.svg";
import xIcon from "@tabler/icons/outline/x.svg";
import type { AgentChoices } from "./agentPanel";
import { post } from "./post";
import { attemptStatus, diffTotals, memberTitle } from "./tabRows";
import type { TabState } from "./tabs";

function Attempt({ tab, state, agents, onOpen }: { tab: TabInfo; state: TabState | undefined; agents: AgentChoices["agents"]; onOpen: (id: number) => void }) {
  const { t } = useL10n();
  const diff = state?.worktreeDiff;
  const status = attemptStatus(tab, state);
  const running = status === "bestOf.running";
  const files = diff?.files ?? [];
  const totals = diff && diffTotals(diff);
  return (
    <section className="attempt" data-status={status} aria-label={memberTitle(tab, agents)}>
      <header className="attempt-head">
        <span className="attempt-agent">{memberTitle(tab, agents)}</span>
        <span className="attempt-status">{t(status)}</span>
      </header>
      {!tab.worktree && tab.attempt !== "running" && tab.attempt !== "failed" ? (
        <div className="attempt-note">{t("bestOf.noWorktree")}</div>
      ) : diff?.error ? (
        <div className="attempt-note">{t("bestOf.diffFailed", diff.error)}</div>
      ) : files.length === 0 ? (
        diff && <div className="attempt-note">{t("bestOf.noChanges")}</div>
      ) : (
        <details className="attempt-files">
          <summary>
            {t("bestOf.files", files.length)} <span className="diff-added">+{totals!.added}</span> <span className="diff-removed">−{totals!.removed}</span>
          </summary>
          <ul>
            {files.map((file) => (
              <li key={file.path}>
                <button type="button" title={file.path} disabled={file.added === undefined} onClick={() => post({ type: "openWorktreeDiff", tab: tab.id, path: file.path })}>
                  <span className="attempt-path">{file.path}</span>
                  {file.added === undefined ? (
                    <span className="attempt-count">{t("bestOf.binary")}</span>
                  ) : (
                    <span className="attempt-count">
                      <span className="diff-added">+{file.added}</span> <span className="diff-removed">−{file.removed}</span>
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
      <div className="attempt-actions">
        <button type="button" className="secondary" onClick={() => onOpen(tab.id)}>
          {t("bestOf.openChat")}
        </button>
        <button
          type="button"
          title={t("bestOf.applyTitle")}
          disabled={running || files.length === 0 || !tab.worktree}
          onClick={() => post({ type: "applyWorktree", tab: tab.id })}
        >
          {t("bestOf.apply")}
        </button>
      </div>
    </section>
  );
}

/** The comparison of a group's tabs: what each agent changed, and the way to apply the best. */
export function GroupPanel({
  group,
  members,
  states,
  agents,
  onOpen,
}: {
  group: TabGroupInfo;
  members: TabInfo[];
  states: Record<number, TabState>;
  agents: AgentChoices["agents"];
  onOpen: (id: number) => void;
}) {
  const { t } = useL10n();
  return (
    <div id="group-panel">
      <div id="group-header">
        <span id="group-title">{group.title}</span>
        <button className="icon-btn" title={t("bestOf.refresh")} aria-label={t("bestOf.refresh")} onClick={() => post({ type: "refreshGroup", group: group.id })}>
          <Icon svg={refreshIcon} />
        </button>
        <button className="icon-btn" title={t("bestOf.closeGroup")} aria-label={t("bestOf.closeGroup")} onClick={() => post({ type: "closeGroup", group: group.id })}>
          <Icon svg={xIcon} />
        </button>
      </div>
      {group.prompt && (
        <details id="group-prompt">
          <summary>{t("bestOf.prompt")}</summary>
          <div>{group.prompt}</div>
        </details>
      )}
      <div id="group-attempts">
        {members.map((tab) => (
          <Attempt key={tab.id} tab={tab} state={states[tab.id]} agents={agents} onOpen={onOpen} />
        ))}
      </div>
      {!members.some((tab) => tab.applied) && (
        <div id="group-actions">
          <button type="button" className="secondary" title={t("bestOf.discardTitle")} onClick={() => post({ type: "discardGroup", group: group.id })}>
            {t("bestOf.discardAll")}
          </button>
        </div>
      )}
    </div>
  );
}
