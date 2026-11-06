import { useEffect, useState } from "react";
import type { CatalogAgent, CatalogState } from "../../agentCatalog";
import type { DoctorRow, DoctorState } from "../../doctor";
import { DOCTOR_STATUS } from "../doctorStatus";
import { Icon } from "../icon";
import { useL10n } from "../l10n";
import checkIcon from "@tabler/icons/outline/check.svg";
import loaderIcon from "@tabler/icons/outline/loader-2.svg";
import { AgentIcon } from "./agentIcon";
import type { AgentChoices } from "./agentPanel";
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

/** Suggested agents to pick from, and the way to all the others. */
export function AgentPicker({ catalog }: { catalog: CatalogState }) {
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
              {agent.busy && (
                <span className="setup-busy">
                  <Icon svg={loaderIcon} />
                </span>
              )}
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

/**
 * Where the check of the tools stands: "failed" when a tool the suggested agents need is missing, "warned" when only
 * optional ones are.
 */
export function checkOutcome({ rows, running }: DoctorState): "checking" | "failed" | "warned" | "passed" {
  if (running || !rows.length || rows.some((row) => !row.result)) return "checking";
  if (rows.some((row) => row.result?.status === "error")) return "failed";
  return rows.some((row) => row.result?.status === "warning") ? "warned" : "passed";
}

function CheckRow({ row }: { row: DoctorRow }) {
  const { t } = useL10n();
  const { result } = row;
  const status = result?.status ?? "pending";
  const { icon, label } = DOCTOR_STATUS[status];
  return (
    <div className={`setup-check ${status}`}>
      <span className="setup-check-status" role="img" aria-label={t(label)} title={t(label)}>
        <Icon svg={icon} />
      </span>
      <span className="setup-agent-text">
        <span className="setup-agent-name">{row.label}</span>
        <span className="setup-check-detail">{result?.detail ?? result?.description}</span>
      </span>
      {result?.fix?.type === "open" && (
        <button type="button" className="secondary" onClick={() => post({ type: "doctorFix", id: row.id })}>
          {t("doctor.fix.open")}
        </button>
      )}
    </div>
  );
}

/** The result of the check of the tools; the way on is only open when nothing needed is missing. */
function SetupChecks({ doctor, onContinue }: { doctor: DoctorState; onContinue: () => void }) {
  const { t } = useL10n();
  const outcome = checkOutcome(doctor);
  const message = {
    checking: "doctor.checking",
    failed: "chat.setup.checkFailed",
    warned: "chat.setup.checkWarned",
    passed: "doctor.allGood",
  } as const;
  return (
    <div id="agent-setup">
      <h2>{t("chat.setup.checkTitle")}</h2>
      <p className="setup-desc" role="status">
        {t(message[outcome])}
      </p>
      <div className="setup-agents">
        {doctor.rows.map((row) => (
          <CheckRow key={row.id} row={row} />
        ))}
      </div>
      <div className="setup-actions">
        {outcome === "warned" && (
          <button type="button" onClick={onContinue}>
            {t("chat.setup.next")}
          </button>
        )}
        {(outcome === "failed" || outcome === "warned") && (
          <button
            type="button"
            className={outcome === "warned" ? "secondary" : undefined}
            onClick={() => post({ type: "doctorRun" })}
          >
            {t("doctor.runAgain")}
          </button>
        )}
      </div>
    </div>
  );
}

/** Shown until an agent is installed: checks the tools, and offers agents once that passes. */
export function AgentSetup({ catalog, doctor }: { catalog: CatalogState; doctor: DoctorState }) {
  const [continued, setContinued] = useState(false);
  useEffect(() => post({ type: "doctorRun" }), []);
  return continued || checkOutcome(doctor) === "passed" ? (
    <AgentPicker catalog={catalog} />
  ) : (
    <SetupChecks doctor={doctor} onContinue={() => setContinued(true)} />
  );
}
