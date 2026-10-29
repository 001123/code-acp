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
  return (
    <details id="changes">
      <summary>
        <span className="changes-count">{files.length === 1 ? t("changes.countOne") : t("changes.count", files.length)}</span>
        <span className="spacer" />
        {(changes?.turns.length ?? 0) > 0 && (
          <button
            className="secondary"
            title={t("checkpoints.pick")}
            onClick={(e) => (e.preventDefault(), post({ type: "pickCheckpoint", tab }))}
          >
            {t("changes.restorePick")}
          </button>
        )}
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
          <div key={f.path} className="changes-file">
            <a href="#" title={f.path} onClick={(e) => (e.preventDefault(), post({ type: "openDiff", tab, path: f.path }))}>
              {f.name}
            </a>
            {(f.created || f.deleted || f.binary) && (
              <span className="changes-new">
                {[f.created && t("changes.created"), f.deleted && t("changes.deleted"), f.binary && t("changes.binary")]
                  .filter(Boolean)
                  .join(", ")}
              </span>
            )}
            {!f.binary && (
              <span className="changes-stats">
                <span className="added">+{f.added}</span> <span className="removed">−{f.removed}</span>
              </span>
            )}
            <span className="spacer" />
            <button className="icon-btn small" title={t("chat.openDiff")} aria-label={t("chat.openDiff")} onClick={() => post({ type: "openDiff", tab, path: f.path })}>
              <Icon svg={diffIcon} />
            </button>
            <button className="icon-btn small" title={t("changes.undo")} aria-label={t("changes.undo")} onClick={() => post({ type: "undoChanges", tab, path: f.path })}>
              <Icon svg={undoIcon} />
            </button>
            <button className="icon-btn small" title={t("changes.keep")} aria-label={t("changes.keep")} onClick={() => post({ type: "keepChanges", tab, path: f.path })}>
              <Icon svg={checkIcon} />
            </button>
          </div>
        ))}
      </div>
    </details>
  );
}
