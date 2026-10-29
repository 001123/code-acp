import type { ChangesMessage } from "../../chat/protocol";
import { Icon } from "../icon";
import { useL10n } from "../l10n";
import undoIcon from "@tabler/icons/outline/arrow-back-up.svg";
import checkIcon from "@tabler/icons/outline/check.svg";
import diffIcon from "@tabler/icons/outline/file-diff.svg";
import { post } from "./post";

/** The files the agent changed that are not reviewed yet: open the diff, keep or undo each, or all. */
export function ChangesBar({ tab, changes }: { tab: number; changes: ChangesMessage | undefined }) {
  const { t } = useL10n();
  const files = changes?.files ?? [];
  if (files.length === 0) return null;
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
          <div key={f.path} className={f.deleted ? "changes-file deleted" : "changes-file"}>
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
        ))}
      </div>
    </details>
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
