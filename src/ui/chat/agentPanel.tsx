import type { ReactNode } from "react";
import type { TabInfo } from "../../chat/protocol";
import { Icon } from "../icon";
import { useL10n } from "../l10n";
import updateIcon from "@tabler/icons/outline/cloud-download.svg";
import robotIcon from "@tabler/icons/outline/robot.svg";
import { SubMenu, SubMenuContext, useHoverMenu, useSubMenus } from "./popupMenu";
import { post } from "./post";

export interface AgentChoices {
  /** `update`: the newer registry version the agent can be updated to. */
  agents: ReadonlyArray<{ id: string; name: string; icon?: string; update?: string }>;
  activeId?: string;
}

const MANAGE_AGENTS = "\0manage";

/** The agent's registry icon, tinted with the text color; the robot when it has none. */
function AgentIcon({ icon }: { icon: string | undefined }) {
  return icon ? <span className="agent-icon" style={{ maskImage: `url("${icon}")` }} /> : <Icon svg={robotIcon} />;
}

/**
 * The agent button and the session's `summary` beside it: hovering either opens a panel that picks the tab's agent (the
 * last entry opens the agent manager), installs its update, and holds the session's config options (`children`).
 */
export function AgentPanel({
  tab,
  choices,
  summary,
  children,
}: {
  tab: TabInfo | undefined;
  choices: AgentChoices;
  summary?: ReactNode;
  children?: ReactNode;
}) {
  const { t } = useL10n();
  const menu = useHoverMenu();
  const subMenus = useSubMenus(menu.open);
  const { agents, activeId } = choices;
  // A tab without a pick yet gets the default.
  const picked = tab?.agentId ?? activeId;
  const current = agents.find((a) => a.id === picked);
  const value = current?.id ?? "";
  const label = current?.name ?? t("chat.noAgentSelected");
  return (
    <div id="agent" {...menu.rootProps}>
      <button
        type="button"
        className="icon-btn"
        title={label}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={menu.open}
        data-update={current?.update ? "" : undefined}
        onClick={menu.toggle}
      >
        <AgentIcon icon={current?.icon} />
      </button>
      {summary}
      {menu.open && (
        <div id="agent-panel" className="popup-menu" role="dialog" aria-label={t("chat.agentSettings")}>
          <SubMenuContext.Provider value={subMenus}>
            <div className="panel-head">
              <SubMenu
                id="agent"
                className="agent-switch"
                title={t("chat.switchAgent")}
                trigger={
                  <>
                    <AgentIcon icon={current?.icon} />
                    <span className="menu-label">{label}</span>
                  </>
                }
                entries={[
                  ...agents.map((a) => ({
                    value: a.id,
                    label: (
                      <>
                        <AgentIcon icon={a.icon} />
                        {a.name}
                        {a.update && <span className="submenu-value">↑ {a.update}</span>}
                      </>
                    ),
                  })),
                  "separator" as const,
                  { value: MANAGE_AGENTS, label: t("chat.manageAgents") },
                ]}
                current={value}
                onPick={(id) => {
                  if (id === MANAGE_AGENTS) post({ type: "manageAgents" });
                  else if (id !== value && tab) post({ type: "setAgent", tab: tab.id, id });
                }}
              />
              {current?.update && (
                <button
                  type="button"
                  id="agent-update"
                  title={t("chat.updateAgent", current.update)}
                  onClick={() => post({ type: "updateAgent", id: current.id })}
                >
                  <Icon svg={updateIcon} />
                  <span className="label-text">{current.update}</span>
                </button>
              )}
            </div>
            {children}
          </SubMenuContext.Provider>
        </div>
      )}
    </div>
  );
}
