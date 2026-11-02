import { useEffect } from "react";
import type { SettingKey } from "../../settings";
import { useL10n, type MessageKey } from "../l10n";
import { Field, Segmented, Toggle } from "./fields";
import { set } from "./post";
import { optionsKey, stringOf, type LoadedOptions, type State } from "./state";

/** The agent and session settings of a feature that runs its own agent sessions (commit messages). */
export function AgentModelFields(props: {
  id: string;
  agentKey: SettingKey;
  modelKey: SettingKey;
  effortKey: SettingKey;
  fastModeKey: SettingKey;
  /** The effort setting's default, put back when another agent is picked. */
  effortDefault: string;
  agentDesc: MessageKey;
  effortDesc: MessageKey;
  state: State;
  loaded: LoadedOptions;
  load: (agentId: string, model: string) => void;
}) {
  const { t } = useL10n();
  const { id, agentKey, modelKey, effortKey, fastModeKey, state } = props;
  const agent = stringOf(state, agentKey);
  const model = stringOf(state, modelKey);
  const effort = stringOf(state, effortKey, props.effortDefault);
  const fastMode = stringOf(state, fastModeKey, "default");
  const ready = state.agents.length > 0;
  const loaded = props.loaded[optionsKey(agent, model)];
  const loading = !loaded || (!loaded.options && loaded.error === undefined);
  const options = loaded?.options;
  // The agent's models don't depend on the model picked: those listed stay while another model's efforts load.
  const models = options?.models ?? Object.values(props.loaded).find((l) => l.agentId === agent && l.options)?.options?.models;

  // The agent's options are read as soon as the page shows them, then whenever another agent or model is picked.
  useEffect(() => {
    if (ready && !loaded) props.load(agent, model);
  }, [ready, agent, model]);

  const efforts = options?.efforts;
  // "lowest" picks the first level the model has; empty (the agent's default) picks none.
  const pickedEffort = effort === "lowest" && efforts?.length ? efforts[0]!.value : effort;
  const unknownEffort = !!efforts && effort !== "" && effort !== "lowest" && !efforts.some((e) => e.value === effort);
  // Until the levels are read, the setting alone is shown.
  const effortChoices = efforts
    ? efforts.map((e) => ({ value: e.value, label: e.name, title: e.description }))
    : effort
      ? [{ value: pickedEffort, label: effort === "lowest" ? t("settings.effortLowest") : effort }]
      : [];
  const effortNote = efforts?.find((e) => e.value === pickedEffort)?.description;

  const noFastMode = !!options && !options.fastMode;
  const fastOn = fastMode === "on" || (fastMode === "default" && options?.defaultFastMode === true);

  return (
    <>
      <Field id={`${id}-agent`} label="settings.commitAgent" desc={props.agentDesc} overridden={state.overridden.includes(agentKey)}>
        <select
          id={`${id}-agent`}
          value={agent}
          onChange={(e) => {
            set(agentKey, e.target.value);
            // Another agent's options don't apply.
            set(modelKey, "");
            set(effortKey, props.effortDefault);
            set(fastModeKey, "default");
          }}
        >
          <option value="">{t("settings.commitAgentDefault")}</option>
          {state.agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.version ? `${a.name} ${a.version}` : a.name}
            </option>
          ))}
          {agent && !state.agents.some((a) => a.id === agent) && <option value={agent}>{agent}</option>}
        </select>
      </Field>
      <Field
        id={`${id}-model`}
        label="settings.commitModel"
        desc="settings.commitModelDesc"
        overridden={state.overridden.includes(modelKey)}
        error={loaded?.error}
      >
        <div className="row">
          <select id={`${id}-model`} value={model} onChange={(e) => set(modelKey, e.target.value)}>
            <option value="">{t("settings.commitModelDefault")}</option>
            {models?.map((m) => (
              <option key={m.value} value={m.value}>
                {m.name}
              </option>
            ))}
            {model && !models?.some((m) => m.value === model) && <option value={model}>{model}</option>}
          </select>
          <button className="secondary" disabled={loading} title={t("settings.reloadOptionsTitle")} onClick={() => props.load(agent, model)}>
            {t("settings.reloadOptions")}
          </button>
        </div>
        {loading && <div className="note muted">{t("settings.loadingOptions")}</div>}
        {models?.length === 0 && <div className="note muted">{t("settings.noModels")}</div>}
      </Field>
      <Field id={`${id}-effort`} label="settings.effort" desc={props.effortDesc} overridden={state.overridden.includes(effortKey)}>
        {efforts?.length === 0 ? (
          <div className="note muted">{t("settings.noEfforts")}</div>
        ) : (
          <Segmented
            id={`${id}-effort`}
            value={pickedEffort}
            options={effortChoices}
            onChange={(value) => set(effortKey, value)}
            disabled={!efforts}
          />
        )}
        {effortNote && <div className="note muted">{effortNote}</div>}
        {unknownEffort && <div className="note warning">{t("settings.effortNotOffered", effort)}</div>}
      </Field>
      <Field
        id={`${id}-fast`}
        label="settings.fastMode"
        desc={noFastMode ? "settings.noFastMode" : "settings.fastModeDesc"}
        overridden={state.overridden.includes(fastModeKey)}
        inline
      >
        <Toggle
          id={`${id}-fast`}
          checked={fastOn}
          // Left on while set, so it can be turned off.
          disabled={noFastMode && !fastOn}
          // Back to the agent's own state, nothing is kept in settings.json.
          onChange={(checked) => set(fastModeKey, checked === (options?.defaultFastMode ?? false) ? "default" : checked ? "on" : "off")}
        />
      </Field>
    </>
  );
}
