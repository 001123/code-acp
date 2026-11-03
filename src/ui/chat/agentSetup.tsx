import { useEffect, useState } from "react";
import type { CatalogAgent, CatalogState } from "../../agentCatalog";
import { Icon } from "../icon";
import { useL10n } from "../l10n";
import checkIcon from "@tabler/icons/outline/check.svg";
import loaderIcon from "@tabler/icons/outline/loader-2.svg";
import { AgentIcon, type AgentChoices } from "./agentPanel";
import { post } from "./post";

/** Registry ids of the agents offered first, in order. */
const SUGGESTED_AGENTS = ["claude-acp", "codex-acp", "antigravity-acp"];

/** The suggested agents the registry has and this machine can install. */
export function suggestedAgents(agents: ReadonlyArray<CatalogAgent>): CatalogAgent[] {
  return SUGGESTED_AGENTS.flatMap((id) => agents.find((agent) => agent.id === id && agent.kind) ?? []);
}

/** No agent yet, or the first ones are still installing: an install started here finishes before the chat shows. */
export function needsSetup(agents: AgentChoices["agents"], catalog: CatalogState): boolean {
  return agents.length === 0 || catalog.agents.some((agent) => agent.busy);
}

/** Shown until an agent is installed: suggested agents to pick from, and the way to all the others. */
export function AgentSetup({ catalog }: { catalog: CatalogState }) {
  const { t } = useL10n();
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => post({ type: "catalogLoad" }), []);
  const suggested = suggestedAgents(catalog.agents);
  const installing = catalog.agents.some((agent) => agent.busy);
  const chosen = suggested.filter((agent) => picked.has(agent.id) && !agent.installedVersion);
  const toggle = (id: string) =>
    setPicked((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  return (
    <div id="agent-setup">
      <h2>{t("chat.setup.title")}</h2>
      <p className="setup-desc">{t("chat.setup.desc")}</p>
      {catalog.error && <p className="setup-error">{catalog.error}</p>}
      {catalog.loading && !suggested.length && <p className="setup-desc">{t("manager.loading")}</p>}
      {suggested.length > 0 && (
        <div className="setup-agents">
          {suggested.map((agent) => (
            <label key={agent.id} className="setup-agent" title={agent.description}>
              <input
                type="checkbox"
                checked={picked.has(agent.id) || !!agent.installedVersion}
                disabled={installing || !!agent.installedVersion}
                onChange={() => toggle(agent.id)}
              />
              <AgentIcon icon={agent.icon} />
              <span className="setup-agent-text">
                <span className="setup-agent-name">{agent.name}</span>
                <span className="setup-agent-desc">{agent.busy ?? agent.description}</span>
              </span>
              {agent.busy && <span className="setup-busy"><Icon svg={loaderIcon} /></span>}
              {!agent.busy && agent.installedVersion && <Icon svg={checkIcon} />}
            </label>
          ))}
        </div>
      )}
      <div className="setup-actions">
        {suggested.length > 0 && (
          <button
            type="button"
            disabled={installing || !chosen.length}
            onClick={() => {
              for (const agent of chosen) post({ type: "catalogInstall", id: agent.id });
            }}
          >
            {t(installing ? "manager.installing" : "chat.setup.continue")}
          </button>
        )}
        {catalog.error && !catalog.loading && (
          <button type="button" className="secondary" onClick={() => post({ type: "catalogRefresh" })}>
            {t("chat.retry")}
          </button>
        )}
        <button type="button" className="secondary" onClick={() => post({ type: "manageAgents" })}>
          {t("chat.setup.more")}
        </button>
      </div>
    </div>
  );
}
