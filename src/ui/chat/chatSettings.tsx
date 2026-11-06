import { Icon } from "../icon";
import { useL10n } from "../l10n";
import tracingIcon from "@tabler/icons/outline/activity.svg";
import generalIcon from "@tabler/icons/outline/adjustments-horizontal.svg";
import autoScrollIcon from "@tabler/icons/outline/arrow-bar-to-down.svg";
import followIcon from "@tabler/icons/outline/eye.svg";
import changesIcon from "@tabler/icons/outline/file-diff.svg";
import restoreIcon from "@tabler/icons/outline/restore.svg";
import settingsIcon from "@tabler/icons/outline/settings.svg";
import { SubMenu, SubMenuContext, useHoverMenu, useSubMenus, type SubMenuEntry } from "./popupMenu";
import { post } from "./post";

type ChatSettingsProps = {
  followAgent: boolean;
  autoScroll: boolean;
  showChanges: boolean;
  showRestore: boolean;
  tracing: boolean;
};

const withIcon = (svg: string, label: string) => (
  <>
    <Icon svg={svg} />
    {label}
  </>
);

/** The gear beside the send button: the General settings in a sub-menu, tracing, and a way to the extension settings. */
export function ChatSettings(props: ChatSettingsProps) {
  const { t } = useL10n();
  const menu = useHoverMenu();
  const subMenus = useSubMenus(menu.open);
  const general: ReadonlyArray<SubMenuEntry> = [
    {
      toggle: "follow",
      label: withIcon(followIcon, t("settings.followAgent")),
      title: t("settings.followAgentDesc"),
      on: props.followAgent,
      onToggle: () => post({ type: "setFollowAgent", enabled: !props.followAgent }),
    },
    {
      toggle: "auto-scroll",
      label: withIcon(autoScrollIcon, t("settings.autoScroll")),
      title: t("settings.autoScrollDesc"),
      on: props.autoScroll,
      onToggle: () => post({ type: "setAutoScroll", enabled: !props.autoScroll }),
    },
    {
      toggle: "show-changes",
      label: withIcon(changesIcon, t("settings.showChanges")),
      title: t("settings.showChangesDesc"),
      on: props.showChanges,
      onToggle: () => post({ type: "setShowChanges", enabled: !props.showChanges }),
    },
    {
      toggle: "show-restore",
      label: withIcon(restoreIcon, t("settings.showRestore")),
      title: t("settings.showRestoreDesc"),
      on: props.showRestore,
      onToggle: () => post({ type: "setShowRestore", enabled: !props.showRestore }),
    },
  ];
  return (
    <div id="chat-settings" {...menu.rootProps}>
      <button
        type="button"
        className="icon-btn"
        // The tooltip would cover the menu that the same hover opens.
        title={menu.open ? undefined : t("chat.viewSettings")}
        aria-label={t("chat.viewSettings")}
        aria-haspopup="menu"
        aria-expanded={menu.open}
        onClick={menu.press}
      >
        <Icon svg={settingsIcon} />
      </button>
      {menu.open && (
        <div id="chat-settings-menu" className="popup-menu" role="menu">
          <SubMenuContext.Provider value={subMenus}>
            <SubMenu
              id="general"
              className="general-row"
              trigger={
                <>
                  <Icon svg={generalIcon} />
                  <span className="menu-label">{t("settings.general")}</span>
                </>
              }
              entries={general}
            />
          </SubMenuContext.Provider>
          <button
            type="button"
            id="tracing"
            role="menuitemcheckbox"
            aria-checked={props.tracing}
            title={`${t("settings.tracingDesc")} ${t("settings.tracingPrivacy")}`}
            onClick={() => post({ type: "setTracing", enabled: !props.tracing })}
          >
            <Icon svg={tracingIcon} />
            <span className="menu-label">{t("settings.tracing")}</span>
            <span className="switch" aria-hidden="true" />
          </button>
          <div className="menu-separator" role="separator" />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              post({ type: "openSettings" });
              menu.toggle();
            }}
          >
            <Icon svg={settingsIcon} />
            <span className="menu-label">{t("chat.openSettings")}</span>
          </button>
        </div>
      )}
    </div>
  );
}
