import type * as acp from "@agentclientprotocol/sdk";
import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import type { TabInfo } from "../../chat/protocol";
import { Icon } from "../icon";
import { useL10n } from "../l10n";
import { useMessages } from "../vscode";
import chevronDownIcon from "@tabler/icons/outline/chevron-down.svg";
import { AgentIcon } from "./agentIcon";
import type { ModelPrefs } from "../modelPrefs";
import type { FavoriteModel } from "./modelFavorites";
import { ModelPicker, type AgentPreview } from "./modelPicker";
import { useHoverMenu } from "./popupMenu";
import { post } from "./post";
import { configKind, type SelectOption } from "./sessionConfig";

export { AgentIcon };

export interface AgentChoices {
  /** `update`: the newer registry version the agent can be updated to; the rest is what codeAcp.providers says of its models. */
  agents: ReadonlyArray<{ id: string; name: string; icon?: string; update?: string } & ModelPrefs>;
  activeId?: string;
  /** The starred models, kept in codeAcp.providers. */
  favorites?: ReadonlyArray<FavoriteModel>;
}

/** The session's config options as the panel shows them. */
export interface AgentConfig {
  options: ReadonlyArray<acp.SessionConfigOption>;
  /** The tab's new session is starting: its options are not known yet. */
  loading: boolean;
  /** Shows a picked value right away; the agent's answer replaces it. */
  onChange: (configId: string, value: string) => void;
}

/**
 * The agent button and the session's `summary` beside it, a button too: hovering or clicking either opens a panel that
 * picks the tab's agent and model (and the session's other options), manages the agents and installs an update.
 */
export function AgentPanel({
  tab,
  choices,
  summary,
  config,
}: {
  tab: TabInfo | undefined;
  choices: AgentChoices;
  summary?: ReactNode;
  config?: AgentConfig;
}) {
  const { t } = useL10n();
  const menu = useHoverMenu();
  const favorites = choices.favorites ?? [];
  // Opened by a click or a key, not a hover: the search may take the focus from the composer.
  const [focusSearch, setFocusSearch] = useState(false);
  useEffect(() => {
    if (!menu.open) setFocusSearch(false);
  }, [menu.open]);
  // What other agents offer, loaded as their buttons in the rail are hovered; a failure is asked again next time.
  const [previews, setPreviews] = useState<Readonly<Record<string, AgentPreview>>>({});
  const asked = useRef(new Set<string>());
  useMessages((msg) => {
    if (msg?.type !== "attemptOptions" || msg.model !== "" || !asked.current.has(msg.agentId)) return;
    asked.current.delete(msg.agentId);
    setPreviews((all) => ({ ...all, [msg.agentId]: { options: msg.options, error: msg.error } }));
  });
  useEffect(() => {
    if (!menu.open) setPreviews((all) => Object.fromEntries(Object.entries(all).filter(([, p]) => !p.error)));
  }, [menu.open]);
  const browse = (id: string) => {
    if (previews[id] || asked.current.has(id)) return;
    asked.current.add(id);
    post({ type: "loadAttemptOptions", agentId: id, model: "" });
  };
  const { agents, activeId } = choices;
  // A tab without a pick yet gets the default.
  const picked = tab?.agentId ?? activeId;
  const current = agents.find((a) => a.id === picked);
  const label = current?.name ?? t("chat.noAgentSelected");

  const setConfig = (configId: string, value: string) => {
    if (!tab) return;
    config?.onChange(configId, value);
    post({ type: "setConfig", tab: tab.id, configId, value });
  };

  // A starred model of another agent, picked once the tab's session with that agent is ready.
  // It is ready once the new session has started loading: until then the options are the old agent's.
  const pending = useRef<{ tab: number; favorite: FavoriteModel; ready: boolean }>(undefined);
  useEffect(() => {
    const p = pending.current;
    if (!p) return;
    if (p.tab !== tab?.id) {
      pending.current = undefined;
      return;
    }
    if (config?.loading) p.ready = true;
    if (!p.ready || tab.agentId !== p.favorite.agent || !config || config.loading || config.options.length === 0)
      return;
    pending.current = undefined;
    const model = config.options.find((o): o is SelectOption => o.type === "select" && configKind(o) === "model");
    const has = model?.options.some((o) =>
      "options" in o ? o.options.some((v) => v.value === p.favorite.value) : o.value === p.favorite.value,
    );
    if (model && has && model.currentValue !== p.favorite.value) setConfig(model.id, p.favorite.value);
  });

  const press = (e: MouseEvent) => {
    setFocusSearch(true);
    menu.press(e);
  };
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
        onClick={press}
      >
        <AgentIcon icon={current?.icon} />
      </button>
      {summary && (
        <button
          type="button"
          id="agent-summary"
          title={t("chat.agentSettings")}
          aria-haspopup="dialog"
          aria-expanded={menu.open}
          onClick={press}
        >
          {summary}
          <Icon svg={chevronDownIcon} />
        </button>
      )}
      {menu.open && (
        <div id="agent-panel" className="popup-menu" role="dialog" aria-label={t("chat.agentSettings")}>
          <ModelPicker
            choices={choices}
            agentId={current?.id}
            config={tab && config?.options}
            loading={!!config?.loading}
            favorites={favorites}
            previews={previews}
            onBrowse={browse}
            focusSearch={focusSearch}
            onSetAgent={(id) => tab && post({ type: "setAgent", tab: tab.id, id })}
            onSetConfig={setConfig}
            onToggleFavorite={(favorite) => post({ type: "toggleFavorite", ...favorite })}
            onPickOther={(favorite) => {
              if (!tab) return;
              pending.current = { tab: tab.id, favorite, ready: false };
              post({ type: "setAgent", tab: tab.id, id: favorite.agent });
            }}
            onManageAgents={() => post({ type: "manageAgents" })}
            onUpdateAgent={(id) => post({ type: "updateAgent", id })}
          />
        </div>
      )}
    </div>
  );
}
