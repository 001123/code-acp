import type { Attachment, QueuedInfo } from "../../chat/protocol";
import { Icon } from "../icon";
import { useL10n } from "../l10n";
import clockIcon from "@tabler/icons/outline/clock.svg";
import pencilIcon from "@tabler/icons/outline/pencil.svg";
import sendNowIcon from "@tabler/icons/outline/player-track-next.svg";
import xIcon from "@tabler/icons/outline/x.svg";
import { attachmentKey, attachmentTitle, imageSrc } from "./attachments";
import type { Preview } from "./context";
import { post } from "./post";

/** A checkbox for how the composer's next message is sent. */
export function ComposerCheckbox({ label, title, checked, disabled, onToggle }: { label: string; title: string; checked: boolean; disabled?: boolean; onToggle: () => void }) {
  return (
    <label className="composer-toggle" title={title}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={onToggle}
        onKeyDown={(e) => {
          // In a form, Enter on a checkbox would send the message.
          if (e.key !== "Enter") return;
          e.preventDefault();
          onToggle();
        }}
      />
      <span>{label}</span>
    </label>
  );
}

/** Messages waiting for the agent: each can go now, come back to the composer, or be dropped. */
export function QueuedMessages({ tab, queue }: { tab: number; queue: QueuedInfo[] }) {
  const { t } = useL10n();
  return (
    <div id="queue" aria-label={t("chat.queued")}>
      {queue.map((q) => (
        <div key={q.id} className="queued">
          <Icon svg={clockIcon} />
          <span className="queued-text" title={q.text}>
            {q.text.trim() || q.attachments.join(", ")}
          </span>
          {q.text.trim() && q.attachments.length > 0 && (
            <span className="queued-more">{t("chat.queuedAttachments", q.attachments.length)}</span>
          )}
          <button
            type="button"
            className="icon-btn small"
            title={t("chat.sendNow")}
            aria-label={t("chat.sendNow")}
            onClick={() => post({ type: "sendQueuedNow", tab, id: q.id })}
          >
            <Icon svg={sendNowIcon} />
          </button>
          <button
            type="button"
            className="icon-btn small"
            title={t("chat.editQueued")}
            aria-label={t("chat.editQueued")}
            onClick={() => post({ type: "unqueue", tab, id: q.id, edit: true })}
          >
            <Icon svg={pencilIcon} />
          </button>
          <button
            type="button"
            className="icon-btn small"
            title={t("chat.removeQueued")}
            aria-label={t("chat.removeQueued")}
            onClick={() => post({ type: "unqueue", tab, id: q.id, edit: false })}
          >
            <Icon svg={xIcon} />
          </button>
        </div>
      ))}
    </div>
  );
}

/** Says the composer holds a sent message being edited. */
export function EditingBar({ onCancel }: { onCancel: () => void }) {
  const { t } = useL10n();
  return (
    <div id="editing">
      <Icon svg={pencilIcon} />
      <span className="editing-text">{t("chat.editing")}</span>
      <button type="button" className="icon-btn small" title={t("chat.cancelEdit")} aria-label={t("chat.cancelEdit")} onClick={onCancel}>
        <Icon svg={xIcon} />
      </button>
    </div>
  );
}

/** The attachments that are not inline in the text. */
export function AttachmentChips({
  attachments,
  onChange,
  setPreview,
}: {
  attachments: Attachment[];
  onChange: (change: (list: Attachment[]) => Attachment[]) => void;
  setPreview: (preview: Preview | undefined) => void;
}) {
  const { t } = useL10n();
  return (
    <div id="attachments">
      {attachments.map((a, i) => (
        <span key={attachmentKey(a) ?? i} className="chip" title={attachmentTitle(t, a)}>
          {imageSrc(a) && (
            <img
              className="chip-preview"
              src={imageSrc(a)}
              title={t("chat.previewImage")}
              onClick={() =>
                setPreview({
                  src: imageSrc(a)!,
                  name: a.name,
                  replace: (b) => onChange((list) => list.map((x) => (x === a ? b : x))),
                })
              }
            />
          )}
          <span>{a.name}</span>
          <button type="button" className="chip-remove" title={t("chat.removeAttachment")} onClick={() => onChange((list) => list.filter((x) => x !== a))}>
            ×
          </button>
        </span>
      ))}
    </div>
  );
}
