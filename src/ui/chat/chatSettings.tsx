import { Icon } from "../icon";
import { useL10n } from "../l10n";
import settingsIcon from "@tabler/icons/outline/settings.svg";
import { useHoverMenu } from "./popupMenu";
import { post } from "./post";

/** The gear beside the send button: a menu of chat view toggles (follow the agent, auto-scroll) and a way to the extension settings. */
export function ChatSettings({ followAgent, autoScroll }: { followAgent: boolean; autoScroll: boolean }) {
  const { t } = useL10n();
  const menu = useHoverMenu();
  const rows = [
    { id: "follow", label: t("settings.followAgent"), title: t("chat.followAgent"), on: followAgent, type: "setFollowAgent" },
    { id: "auto-scroll", label: t("settings.autoScroll"), title: t("chat.autoScroll"), on: autoScroll, type: "setAutoScroll" },
  ] as const;
  return (
    <div id="chat-settings" {...menu.rootProps}>
      <button
        type="button"
        className="icon-btn"
        title={t("chat.viewSettings")}
        aria-label={t("chat.viewSettings")}
        aria-haspopup="menu"
        aria-expanded={menu.open}
        onClick={menu.toggle}
      >
        <Icon svg={settingsIcon} />
      </button>
      {menu.open && (
        <div id="chat-settings-menu" className="popup-menu" role="menu">
          {rows.map((r) => (
            <button
              key={r.id}
              type="button"
              id={r.id}
              role="menuitemcheckbox"
              aria-checked={r.on}
              title={r.title}
              onClick={() => post({ type: r.type, enabled: !r.on })}
            >
              <span className="menu-label">{r.label}</span>
              <span className="switch" aria-hidden="true" />
            </button>
          ))}
          <div className="menu-separator" role="separator" />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              post({ type: "openSettings" });
              menu.toggle();
            }}
          >
            <span className="menu-label">{t("chat.openSettings")}</span>
          </button>
        </div>
      )}
    </div>
  );
}
