import type * as acp from "@agentclientprotocol/sdk";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { AttemptPick } from "../../chat/protocol";
import type { Choice } from "../../sessionOptions";
import { Icon } from "../icon";
import { useL10n } from "../l10n";
import chevronUpIcon from "@tabler/icons/outline/chevron-up.svg";
import plusIcon from "@tabler/icons/outline/plus.svg";
import xIcon from "@tabler/icons/outline/x.svg";
import { AgentIcon, type AgentChoices } from "./agentPanel";
import { ComposerCheckbox } from "./composerParts";
import {
  attemptKey,
  attemptPick,
  modelsIn,
  nextRow,
  type AttemptRow,
  type LoadedAttempt,
  type LoadedAttempts,
} from "./compareAttempts";
import { useClickMenu } from "./popupMenu";
import { post } from "./post";
import { sessionChoices } from "./sessionConfig";

/** A select's options: `usual` for no pick, `choices`, and the value picked when they don't have it (yet). */
function ChoiceOptions({
  choices,
  value,
  usual,
}: {
  choices: ReadonlyArray<Choice> | undefined;
  value: string;
  usual: string;
}) {
  return (
    <>
      <option value="">{usual}</option>
      {choices?.map((c) => (
        <option key={c.value} value={c.value} title={c.description}>
          {c.name}
        </option>
      ))}
      {value && !choices?.some((c) => c.value === value) && <option value={value}>{value}</option>}
    </>
  );
}

/**
 * The composer's Compare checkbox: while on, the message goes to several attempts, each an agent with a model and
 * effort, picked in a popover. Checking it opens the popover; the count beside it opens it again.
 */
export function useCompare({
  agentId,
  agents,
  config,
  editing,
}: {
  /** The active tab's agent. */
  agentId: string | undefined;
  agents: AgentChoices["agents"];
  config: ReadonlyArray<acp.SessionConfigOption>;
  editing: boolean;
}) {
  const { t } = useL10n();
  const [checked, setChecked] = useState(false);
  const [saved, setRows] = useState<ReadonlyArray<AttemptRow>>([]);
  const [loaded, setLoaded] = useState<LoadedAttempts>({});
  const nextId = useRef(1);
  const menu = useClickMenu();
  const agentIds = agents.map((agent) => agent.id);
  // An agent may be uninstalled while it is picked.
  const rows = saved.filter((row) => agentIds.includes(row.agentId));
  const on = checked && !editing && agents.length > 0;
  const current = sessionChoices(config);
  const modelsOf = (id: string) => modelsIn(loaded, id) ?? (id === agentId ? current.models : undefined);

  const asked = rows.map((row) => attemptKey(row.agentId, row.model)).join("\n");
  useEffect(() => {
    if (!menu.open) return;
    const missing = new Map(
      rows.map((row) => [attemptKey(row.agentId, row.model), row]).filter(([key]) => !loaded[key as string]) as Array<
        [string, AttemptRow]
      >,
    );
    if (missing.size === 0) return;
    setLoaded((all) => ({
      ...all,
      ...Object.fromEntries([...missing].map(([key, { agentId: id, model }]) => [key, { agentId: id, model }])),
    }));
    for (const { agentId: id, model } of missing.values()) post({ type: "loadAttemptOptions", agentId: id, model });
  }, [menu.open, asked]);
  // Closing it is the way to ask again: after logging in, say.
  useEffect(() => {
    if (!menu.open)
      setLoaded((all) => Object.fromEntries(Object.entries(all).filter(([, each]) => each.error === undefined)));
  }, [menu.open]);

  const turnOn = () => {
    setChecked(true);
    menu.set(true);
    if (rows.length >= 2) return;
    const first = agentId !== undefined && agentIds.includes(agentId) ? agentId : agentIds[0]!;
    const seeded: AttemptRow[] = [
      { id: nextId.current++, agentId: first, model: current.model ?? "", effort: current.effort ?? "" },
    ];
    seeded.push(nextRow(nextId.current++, seeded, agentIds, modelsOf));
    setRows(seeded);
  };
  const turnOff = () => {
    setChecked(false);
    menu.set(false);
  };
  const toggle = () => (checked ? turnOff() : turnOn());
  const patch = (id: number, change: Partial<AttemptRow>) =>
    setRows(rows.map((row) => (row.id === id ? { ...row, ...change } : row)));

  const panel = (
    <div id="compare-panel" className="popup-menu" role="dialog" aria-label={t("bestOf.attempts")}>
      <div className="menu-heading">{t("bestOf.attempts")}</div>
      {rows.map((row) => {
        const answer: LoadedAttempt | undefined = loaded[attemptKey(row.agentId, row.model)];
        const efforts = answer?.options?.efforts;
        const loading = answer !== undefined && !answer.options && answer.error === undefined;
        return (
          <div key={row.id} className="compare-row">
            {agents.length > 1 && <AgentIcon icon={agents.find((agent) => agent.id === row.agentId)?.icon} />}
            <div className="compare-picks">
              {agents.length > 1 && (
                <select
                  className="compare-agent"
                  aria-label={t("bestOf.agent")}
                  value={row.agentId}
                  onChange={(e) => patch(row.id, { agentId: e.target.value, model: "", effort: "" })}
                >
                  {agents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name}
                    </option>
                  ))}
                </select>
              )}
              <div
                className="compare-options"
                aria-busy={loading}
                title={loading ? t("chat.loadingOptions") : undefined}
              >
                <select
                  aria-label={t("bestOf.model")}
                  value={row.model}
                  // The levels are the model's own.
                  onChange={(e) => patch(row.id, { model: e.target.value, effort: "" })}
                >
                  <ChoiceOptions choices={modelsOf(row.agentId)} value={row.model} usual={t("bestOf.usualModel")} />
                </select>
                {efforts?.length !== 0 && (
                  <select
                    aria-label={t("bestOf.effort")}
                    disabled={!efforts}
                    value={row.effort}
                    onChange={(e) => patch(row.id, { effort: e.target.value })}
                  >
                    <ChoiceOptions choices={efforts} value={row.effort} usual={t("bestOf.usualEffort")} />
                  </select>
                )}
              </div>
              {answer?.error !== undefined && <div className="compare-error">{answer.error}</div>}
            </div>
            {rows.length > 2 && (
              <button
                type="button"
                className="icon-btn small compare-remove"
                title={t("bestOf.removeAttempt")}
                aria-label={t("bestOf.removeAttempt")}
                onClick={() => setRows(rows.filter((each) => each.id !== row.id))}
              >
                <Icon svg={xIcon} />
              </button>
            )}
          </div>
        );
      })}
      <button
        type="button"
        id="compare-add"
        onClick={() => setRows([...rows, nextRow(nextId.current++, rows, agentIds, modelsOf)])}
      >
        <Icon svg={plusIcon} />
        <span className="menu-label">{t("bestOf.addAttempt")}</span>
      </button>
      <div className="compare-note">{t("bestOf.note")}</div>
    </div>
  );

  const element: ReactNode = !editing && agents.length > 0 && (
    <div id="compare" ref={menu.root}>
      <ComposerCheckbox label={t("bestOf.compare")} title={t("bestOf.compareTitle")} checked={on} onToggle={toggle} />
      {on && (
        <button
          type="button"
          id="compare-count"
          title={t("bestOf.editAttempts")}
          aria-label={t("bestOf.editAttempts")}
          aria-haspopup="dialog"
          aria-expanded={menu.open}
          onClick={menu.toggle}
        >
          {rows.length}
          <Icon svg={chevronUpIcon} />
        </button>
      )}
      {on && menu.open && panel}
    </div>
  );

  return {
    /** The next message goes to the attempts. */
    on,
    count: rows.length,
    attempts: (): AttemptPick[] => rows.map((row) => attemptPick(row, loaded, modelsOf)),
    /** A comparison starts worktrees and sessions: each takes checking the box, while the picks stay for the next. */
    turnOff,
    receive: (answer: LoadedAttempt) =>
      setLoaded((all) => ({ ...all, [attemptKey(answer.agentId, answer.model)]: answer })),
    element,
  };
}
