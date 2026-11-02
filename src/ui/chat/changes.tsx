import { Fragment, useEffect, useState } from "react";
import type { ChangedFile, ChangeHunk, ChangesMessage } from "../../chat/protocol";
import { Icon } from "../icon";
import { useL10n } from "../l10n";
import undoIcon from "@tabler/icons/outline/arrow-back-up.svg";
import checkIcon from "@tabler/icons/outline/check.svg";
import chevronIcon from "@tabler/icons/outline/chevron-right.svg";
import diffIcon from "@tabler/icons/outline/file-diff.svg";
import { post } from "./post";

/** Lines shown of one change; the rest are in its diff. */
const MAX_HUNK_LINES = 200;

/** The files the agent changed that are not reviewed yet: open the diff, keep or undo each change, each file, or all. */
export function ChangesBar({
  tab,
  changes,
  hunks,
}: {
  tab: number;
  changes: ChangesMessage | undefined;
  hunks: Record<string, ChangeHunk[]> | undefined;
}) {
  const { t } = useL10n();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const files = changes?.files ?? [];
  // Every new list of files can change the changes in them.
  useEffect(() => {
    for (const f of changes?.files ?? []) {
      if (expanded.has(f.path) && hasHunks(f)) post({ type: "listHunks", tab, path: f.path });
    }
  }, [tab, changes, expanded]);
  if (files.length === 0) return null;
  const toggle = (path: string) =>
    setExpanded((was) => {
      const next = new Set(was);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  return (
    <details id="changes">
      <summary>
        <span className="changes-count">{files.length === 1 ? t("changes.countOne") : t("changes.count", files.length)}</span>
        <Stats added={added} removed={removed} />
        <span className="spacer" />
        <button
          className="secondary"
          onClick={(e) => (e.preventDefault(), post({ type: "undoChanges", tab }))}
        >
          {t("changes.undoAll")}
        </button>
        <button onClick={(e) => (e.preventDefault(), post({ type: "keepChanges", tab }))}>{t("changes.keepAll")}</button>
      </summary>
      <div className="changes-list">
        {files.map((f) => (
          <Fragment key={f.path}>
          <div className={f.deleted ? "changes-file deleted" : "changes-file"}>
            {hasHunks(f) && (
              <button
                className={expanded.has(f.path) ? "icon-btn small changes-toggle open" : "icon-btn small changes-toggle"}
                title={t("changes.showHunks")}
                aria-label={t("changes.showHunks")}
                aria-expanded={expanded.has(f.path)}
                onClick={() => toggle(f.path)}
              >
                <Icon svg={chevronIcon} />
              </button>
            )}
            <a href="#" title={f.path} onClick={(e) => (e.preventDefault(), post({ type: "openDiff", tab, path: f.path }))}>
              <span className="changes-base">{baseName(f.name)}</span>
              {dirName(f.name) && <span className="changes-dir">{dirName(f.name)}</span>}
            </a>
            {f.created && <span className="changes-tag created">{t("changes.created")}</span>}
            {f.deleted && <span className="changes-tag deleted">{t("changes.deleted")}</span>}
            {f.binary && <span className="changes-tag">{t("changes.binary")}</span>}
            {!f.binary && <Stats added={f.added} removed={f.removed} />}
            <span className="spacer" />
            <span className="changes-actions">
              <button className="icon-btn small" title={t("chat.openDiff")} aria-label={t("chat.openDiff")} onClick={() => post({ type: "openDiff", tab, path: f.path })}>
                <Icon svg={diffIcon} />
              </button>
              <button className="icon-btn small" title={t("changes.undo")} aria-label={t("changes.undo")} onClick={() => post({ type: "undoChanges", tab, path: f.path })}>
                <Icon svg={undoIcon} />
              </button>
              <button className="icon-btn small" title={t("changes.keep")} aria-label={t("changes.keep")} onClick={() => post({ type: "keepChanges", tab, path: f.path })}>
                <Icon svg={checkIcon} />
              </button>
            </span>
          </div>
          {expanded.has(f.path) && hasHunks(f) && <FileHunks tab={tab} path={f.path} hunks={hunks?.[f.path]} />}
          </Fragment>
        ))}
      </div>
    </details>
  );
}

/** Whether the file's changes can be reviewed one by one, rather than as a whole file. */
function hasHunks(f: ChangedFile): boolean {
  return !f.binary && !f.created && !f.deleted;
}

function FileHunks({ tab, path, hunks }: { tab: number; path: string; hunks: ChangeHunk[] | undefined }) {
  const { t } = useL10n();
  if (!hunks) return null;
  if (hunks.length === 0) return <div className="changes-no-hunks">{t("changes.noHunks")}</div>;
  return (
    <div className="changes-hunks">
      {hunks.map((hunk) => {
        const line = hunk.newStart + 1;
        const removed = hunk.removed.slice(0, MAX_HUNK_LINES);
        const added = hunk.added.slice(0, MAX_HUNK_LINES - removed.length);
        const hidden = hunk.removed.length + hunk.added.length - removed.length - added.length;
        return (
          <div key={`${hunk.oldStart}:${hunk.newStart}`} className="changes-hunk">
            <div className="changes-hunk-header">
              <a href="#" onClick={(e) => (e.preventDefault(), post({ type: "openDiff", tab, path, line }))}>
                {t("changes.hunkLine", line)}
              </a>
              <Stats added={hunk.added.length} removed={hunk.removed.length} />
              <span className="spacer" />
              <span className="changes-actions">
                <button className="icon-btn small" title={t("changes.undoHunk")} aria-label={t("changes.undoHunk")} onClick={() => post({ type: "undoHunk", tab, path, hunk })}>
                  <Icon svg={undoIcon} />
                </button>
                <button className="icon-btn small" title={t("changes.keepHunk")} aria-label={t("changes.keepHunk")} onClick={() => post({ type: "keepHunk", tab, path, hunk })}>
                  <Icon svg={checkIcon} />
                </button>
              </span>
            </div>
            <pre className="diff-lines">
              {removed.map((l, i) => (
                <span key={`-${i}`} className="diff-del">
                  - {l}
                  {"\n"}
                </span>
              ))}
              {added.map((l, i) => (
                <span key={`+${i}`} className="diff-add">
                  + {l}
                  {"\n"}
                </span>
              ))}
              {hidden > 0 && <span className="diff-gap">⋯{"\n"}</span>}
            </pre>
          </div>
        );
      })}
    </div>
  );
}

function Stats({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="changes-stats">
      <span className="added">+{added}</span> <span className="removed">−{removed}</span>
    </span>
  );
}

/** The last segment of a workspace-relative path. */
function baseName(name: string): string {
  return name.slice(name.lastIndexOf("/") + 1);
}

/** Everything before the last segment of a workspace-relative path, or "" for a top-level file. */
function dirName(name: string): string {
  const i = name.lastIndexOf("/");
  return i < 0 ? "" : name.slice(0, i);
}
