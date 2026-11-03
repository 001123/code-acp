import type { PrDraft, TabInfo, WorkspaceFolderInfo } from "../../chat/protocol";
import { Icon } from "../icon";
import { useL10n } from "../l10n";
import folderIcon from "@tabler/icons/outline/folder.svg";
import gitBranchIcon from "@tabler/icons/outline/git-branch.svg";
import gitForkIcon from "@tabler/icons/outline/git-fork.svg";
import gitMergeIcon from "@tabler/icons/outline/git-merge.svg";
import { post } from "./post";

/** Picks the workspace folder the tab's session runs in; shown in multi-root workspaces only. */
export function FolderSelect({ tab, folders }: { tab: TabInfo | undefined; folders: ReadonlyArray<WorkspaceFolderInfo> }) {
  const { t } = useL10n();
  if (!tab || folders.length < 2) return null;
  // A tab in a worktree shows the folder it came from.
  const cwd = tab.worktree?.base ?? tab.cwd;
  // A session opened from the history may run in a folder that is not a workspace root.
  const other = folders.some((f) => f.path === cwd) ? undefined : cwd;
  return (
    <span id="folder" className="config-item" title={`${t("chat.switchFolder")}\n${tab.cwd}`}>
      <span className="config-name" aria-hidden="true">
        <Icon svg={folderIcon} />
      </span>
      <select value={cwd} onChange={(e) => post({ type: "setCwd", tab: tab.id, cwd: e.target.value })}>
        {other !== undefined && (
          <option value={other} disabled>
            {other.split(/[\\/]/).filter(Boolean).pop() ?? other}
          </option>
        )}
        {folders.map((f) => (
          <option key={f.path} value={f.path}>
            {f.name}
          </option>
        ))}
      </select>
    </span>
  );
}

/** Under the composer: where the tab works, which opens the worktree picker, and what is checked out there. Shown in git folders only. */
export function WorkspaceBar({ tab, busy }: { tab: TabInfo | undefined; busy: boolean }) {
  const { t } = useL10n();
  const branch = tab?.branch ?? tab?.worktree?.branch;
  if (!tab || (!tab.worktree && branch === undefined)) return null;
  const place = t(tab.worktree ? "worktree.label" : "worktree.local");
  return (
    <div id="workspace-bar" data-worktree={tab.worktree ? true : undefined}>
      <button
        type="button"
        className="workspace-place"
        title={`${t("chat.pickWorktree")}
${tab.cwd}`}
        aria-label={`${t("chat.pickWorktree")}: ${place}`}
        onClick={() => post({ type: "pickWorktree", tab: tab.id })}
      >
        <Icon svg={tab.worktree ? gitForkIcon : folderIcon} />
        <span>{place}</span>
      </button>
      {branch !== undefined && (
        <span className="workspace-branch" title={t("chat.tabBranch", branch)}>
          <Icon svg={gitBranchIcon} />
          <span>{branch}</span>
        </span>
      )}
      {tab.worktree && tab.finishable && !busy && (
        <button type="button" className="workspace-finish" title={t("worktree.finishHint")} onClick={() => post({ type: "finishWorktree", tab: tab.id })}>
          <Icon svg={gitMergeIcon} />
          <span>{t("worktree.finish")}</span>
        </button>
      )}
    </div>
  );
}

/** Above the composer: the pull request the agent drafted, to change and agree to; nothing is pushed before that. */
export function PrDraftForm({ tab, draft, onChange }: { tab: number; draft: PrDraft; onChange: (draft: PrDraft) => void }) {
  const { t } = useL10n();
  return (
    <form
      id="pr-draft"
      onSubmit={(e) => {
        e.preventDefault();
        post({ type: "createPr", tab, title: draft.title, body: draft.body });
      }}
    >
      <fieldset disabled={draft.pending}>
        <div className="pr-draft-title">{t("worktree.prDraftTitle", draft.head, draft.base ?? t("worktree.prDefaultBase"))}</div>
        <label>
          {t("worktree.prTitleLabel")}
          <input value={draft.title} onChange={(e) => onChange({ ...draft, title: e.target.value })} />
        </label>
        <label>
          {t("worktree.prBodyLabel")}
          <textarea rows={8} value={draft.body} onChange={(e) => onChange({ ...draft, body: e.target.value })} />
        </label>
        <div className="pr-draft-actions">
          <button type="submit" disabled={draft.title.trim() === ""}>
            {t("worktree.prCreate")}
          </button>
          <button type="button" className="secondary" onClick={() => post({ type: "dismissPr", tab })}>
            {t("worktree.prDiscard")}
          </button>
          <span className="pr-draft-remote">{t("worktree.prRemote", draft.remote)}</span>
        </div>
      </fieldset>
    </form>
  );
}
