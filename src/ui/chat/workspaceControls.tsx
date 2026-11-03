import type { PrDraft, TabInfo, WorkspaceFolderInfo } from "../../chat/protocol";
import { Icon } from "../icon";
import { useL10n } from "../l10n";
import { useEffect } from "react";
import alertIcon from "@tabler/icons/outline/alert-triangle.svg";
import checkIcon from "@tabler/icons/outline/check.svg";
import folderIcon from "@tabler/icons/outline/folder.svg";
import chevronDownIcon from "@tabler/icons/outline/chevron-down.svg";
import gitBranchIcon from "@tabler/icons/outline/git-branch.svg";
import gitForkIcon from "@tabler/icons/outline/git-fork.svg";
import gitMergeIcon from "@tabler/icons/outline/git-merge.svg";
import gitPullRequestIcon from "@tabler/icons/outline/git-pull-request.svg";
import { ComposerCheckbox } from "./composerParts";
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

/** How often the state of a merge with conflicts is read: they get solved outside the chat, which says nothing about it. */
const CONFLICT_POLL_MS = 3000;

/** What the bar says of a pull request: its number, when its URL ends in one. */
function prNumber(url: string): string {
  return /\/(\d+)\/?$/.exec(url)?.[1] ?? "";
}

/** The work of the tab's worktree: where it went or why it is stuck, and what can be done next. */
function FinishState({ tab, busy }: { tab: TabInfo; busy: boolean }) {
  const { t } = useL10n();
  const { conflict, settled, deletable, finishable } = tab;
  const merging = conflict !== undefined;
  useEffect(() => {
    if (!merging) return;
    const timer = setInterval(() => post({ type: "refreshWorktree", tab: tab.id }), CONFLICT_POLL_MS);
    return () => clearInterval(timer);
  }, [merging, tab.id]);
  if (merging) {
    return (
      <span className="workspace-state" data-conflict>
        <span className="workspace-status">
          <Icon svg={alertIcon} />
          <span>{t("worktree.conflict", conflict)}</span>
        </span>
        <button type="button" className="workspace-action" onClick={() => post({ type: "showWorktreeConflicts", tab: tab.id })}>
          {t("worktree.openChanges")}
        </button>
        <button type="button" className="workspace-action" onClick={() => post({ type: "abortWorktreeMerge", tab: tab.id })}>
          {t("worktree.abortMerge")}
        </button>
      </span>
    );
  }
  const finish = () => post({ type: "finishWorktree", tab: tab.id });
  const number = settled && prNumber(settled.target);
  const label =
    settled?.how === "merged"
      ? t("worktree.doneMerged", settled.target)
      : settled?.how === "applied"
        ? t("worktree.doneApplied", settled.target)
        : settled?.how === "pr"
          ? t("worktree.donePr", number ? `#${number}` : "")
          : settled?.how === "prMerged"
            ? t("worktree.donePrMerged", number ? `#${number}` : "")
            : undefined;
  const isPr = settled?.how === "pr" || settled?.how === "prMerged";
  // Merged, nothing is left to bring anywhere; anything else can still take another way.
  const canRedo = settled !== undefined && settled.how !== "merged" && !finishable;
  const status = (
    <>
      <Icon svg={isPr ? gitPullRequestIcon : checkIcon} />
      <span>{label?.replace(/\s+/g, " ").trim()}</span>
    </>
  );
  return (
    <span className="workspace-state">
      {settled &&
        (canRedo && !busy ? (
          <button type="button" className="workspace-status" title={t("worktree.doneHint")} onClick={finish}>
            {status}
          </button>
        ) : (
          <span className="workspace-status">{status}</span>
        ))}
      {isPr && (
        <button type="button" className="workspace-action" onClick={() => post({ type: "openWorktreePr", tab: tab.id })}>
          {t("worktree.prOpen")}
        </button>
      )}
      {settled && deletable && !finishable && !busy && (
        <button type="button" className="workspace-action" onClick={() => post({ type: "deleteWorktree", tab: tab.id })}>
          {t("worktree.delete")}
        </button>
      )}
      {finishable && !busy && (
        <button type="button" className="workspace-finish" title={t("worktree.finishHint")} onClick={finish}>
          <Icon svg={gitMergeIcon} />
          <span>{t("worktree.finish")}</span>
        </button>
      )}
    </span>
  );
}

/** In the composer: whether the tab's next message moves it to a new worktree. Shown in git folders only, while the tab isn't in a worktree yet; then the bar under the composer tells. */
export function WorktreeToggle({ tab }: { tab: TabInfo | undefined }) {
  const { t } = useL10n();
  if (!tab || tab.worktree || tab.branch === undefined) return null;
  const hint = t(tab.worktreeOnSend ? "worktree.toggleCancel" : "worktree.toggleOn");
  return (
    <div id="worktree">
      <ComposerCheckbox label={t("worktree.label")} title={`${hint}\n${tab.cwd}`} checked={!!tab.worktreeOnSend} onToggle={() => post({ type: "toggleWorktree", tab: tab.id })} />
    </div>
  );
}

/** Under the composer: what is checked out where the tab works, which opens the picker of where it works, and what became of its worktree's work. Shown in git folders only. */
export function WorkspaceBar({ tab, busy }: { tab: TabInfo | undefined; busy: boolean }) {
  const { t } = useL10n();
  const branch = tab?.branch ?? tab?.worktree?.branch;
  if (!tab || (!tab.worktree && branch === undefined)) return null;
  // A worktree may have no branch: its folder names it then.
  const place = branch ?? tab.worktree?.root.split(/[\\/]/).filter(Boolean).pop() ?? tab.cwd;
  const pick = t("chat.pickWorktree");
  return (
    <div id="workspace-bar">
      <button
        type="button"
        className="workspace-branch"
        data-worktree={tab.worktree ? true : undefined}
        title={`${branch !== undefined ? `${t("chat.tabBranch", branch)}\n` : ""}${pick}\n${tab.cwd}`}
        aria-label={`${pick}: ${place}`}
        onClick={() => post({ type: "pickWorktree", tab: tab.id })}
      >
        <Icon svg={tab.worktree ? gitForkIcon : gitBranchIcon} />
        <span>{place}</span>
        <Icon svg={chevronDownIcon} />
      </button>
      {tab.worktree && <FinishState tab={tab} busy={busy} />}
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
