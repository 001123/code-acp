import { useState } from "react";
import type { SettingKey } from "../../settings";
import { useL10n } from "../l10n";
import { AgentModelFields } from "./agentModel";
import { Field, Text, Toggle } from "./fields";
import { parseHosts } from "./hosts";
import { formatPairs, parsePairs } from "./pairs";
import { post, set } from "./post";
import { stringOf, type LoadedOptions, type State } from "./state";

const isOverridden = (state: State) => (key: SettingKey) => state.overridden.includes(key);

export function GeneralTab({ state }: { state: State }) {
  const { t } = useL10n();
  const v = state.values;
  const overridden = isOverridden(state);
  return (
    <section className="card">
      <Field
        id="language"
        label="settings.language"
        desc="settings.languageDesc"
        overridden={overridden("language")}
      >
        <select id="language" value={stringOf(state, "language", "auto")} onChange={(e) => set("language", e.target.value)}>
          <option value="auto">{t("settings.languageAuto")}</option>
          <option value="en">English</option>
          <option value="vi">Tiếng Việt</option>
        </select>
      </Field>
      <Field
        id="followAgent"
        label="settings.followAgent"
        desc="settings.followAgentDesc"
        overridden={overridden("followAgent")}
        inline
      >
        <Toggle id="followAgent" checked={v.followAgent === true} onChange={(checked) => set("followAgent", checked)} />
      </Field>
      <Field
        id="autoScroll"
        label="settings.autoScroll"
        desc="settings.autoScrollDesc"
        overridden={overridden("autoScroll")}
        inline
      >
        <Toggle id="autoScroll" checked={v.autoScroll !== false} onChange={(checked) => set("autoScroll", checked)} />
      </Field>
      <Field
        id="showChanges"
        label="settings.showChanges"
        desc="settings.showChangesDesc"
        overridden={overridden("showChanges")}
        inline
      >
        <Toggle id="showChanges" checked={v.showChanges !== false} onChange={(checked) => set("showChanges", checked)} />
      </Field>
      <Field
        id="tracing"
        label="settings.tracing"
        desc="settings.tracingDesc"
        overridden={overridden("tracing")}
        inline
      >
        <Toggle id="tracing" checked={v.tracing === true} onChange={(checked) => set("tracing", checked)} />
      </Field>
      <Field
        id="rememberSessionOptions"
        label="settings.rememberSessionOptions"
        desc="settings.rememberSessionOptionsDesc"
        overridden={overridden("rememberSessionOptions")}
        inline
      >
        <Toggle
          id="rememberSessionOptions"
          checked={v.rememberSessionOptions !== false}
          onChange={(checked) => set("rememberSessionOptions", checked)}
        />
      </Field>
    </section>
  );
}

export function NotificationsTab({ state }: { state: State }) {
  const v = state.values;
  const overridden = isOverridden(state);
  return (
    <section className="card">
      <Field
        id="notifications"
        label="settings.notifications"
        desc="settings.notificationsDesc"
        overridden={overridden("notifications")}
        inline
      >
        <Toggle id="notifications" checked={v.notifications !== false} onChange={(checked) => set("notifications", checked)} />
      </Field>
      <Field
        id="notifyFinished"
        label="settings.notifyFinished"
        desc="settings.notifyFinishedDesc"
        overridden={overridden("notifyFinished")}
        inline
      >
        <Toggle
          id="notifyFinished"
          checked={v.notifyFinished !== false}
          disabled={v.notifications === false}
          onChange={(checked) => set("notifyFinished", checked)}
        />
      </Field>
    </section>
  );
}

export function WorktreeTab({ state }: { state: State }) {
  const v = state.values;
  const overridden = isOverridden(state);
  return (
    <section className="card">
      <Field
        id="worktreeForNewTabs"
        label="settings.worktreeForNewTabs"
        desc="settings.worktreeForNewTabsDesc"
        overridden={overridden("worktreeForNewTabs")}
        inline
      >
        <Toggle id="worktreeForNewTabs" checked={v.worktreeForNewTabs === true} onChange={(checked) => set("worktreeForNewTabs", checked)} />
      </Field>
    </section>
  );
}

export function AgentTab({ state }: { state: State }) {
  const { t } = useL10n();
  const [envError, setEnvError] = useState<string>();
  const v = state.values;
  const overridden = isOverridden(state);
  const env = formatPairs(v.env as Record<string, string> | undefined);
  return (
    <section className="card">
      <Field id="active-agent" label="settings.activeAgent" desc="settings.activeAgentDesc">
        <div className="row">
          <select
            id="active-agent"
            disabled={!state.agents.length}
            value={state.activeId ?? ""}
            onChange={(e) => post({ type: "use", id: e.target.value })}
          >
            {!state.agents.length && <option value="">{t("settings.noAgents")}</option>}
            {state.agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.version ? `${a.name} ${a.version}` : a.name}
              </option>
            ))}
          </select>
          <button className="secondary" onClick={() => post({ type: "manageAgents" })}>
            {t("settings.manageAgents")}
          </button>
        </div>
      </Field>
      <Field
        id="checkAgentUpdates"
        label="settings.checkUpdates"
        desc="settings.checkUpdatesDesc"
        overridden={overridden("checkAgentUpdates")}
        inline
      >
        <Toggle
          id="checkAgentUpdates"
          checked={v.checkAgentUpdates !== false}
          onChange={(checked) => set("checkAgentUpdates", checked)}
        />
      </Field>
      <Field
        id="nodePath"
        label="settings.nodePath"
        desc="settings.nodePathDesc"
        overridden={overridden("nodePath")}
      >
        <Text
          id="nodePath"
          placeholder="node"
          value={stringOf(state, "nodePath")}
          onCommit={(s) => set("nodePath", s.trim())}
        />
      </Field>
      <Field
        id="ccusagePath"
        label="settings.ccusagePath"
        desc="settings.ccusagePathDesc"
        overridden={overridden("ccusagePath")}
      >
        <Text
          id="ccusagePath"
          placeholder="ccusage"
          value={stringOf(state, "ccusagePath")}
          onCommit={(s) => set("ccusagePath", s.trim())}
        />
      </Field>
      <Field
        id="env"
        label="settings.env"
        desc="settings.envDesc"
        overridden={overridden("env")}
        error={envError}
      >
        <Text
          id="env"
          rows={4}
          placeholder="KEY=VALUE"
          value={env}
          onReset={() => setEnvError(undefined)}
          onCommit={(text) => {
            const parsed = parsePairs(text);
            if (typeof parsed === "number") {
              setEnvError(t("settings.envInvalid", parsed));
              return;
            }
            setEnvError(undefined);
            set("env", parsed);
          }}
        />
      </Field>
    </section>
  );
}

export function LinksTab({ state }: { state: State }) {
  const { t } = useL10n();
  const [error, setError] = useState<string>();
  const hosts = state.values.allowedHttpHosts as ReadonlyArray<string> | undefined;
  return (
    <section className="card">
      <Field
        id="allowedHttpHosts"
        label="settings.allowedHttpHosts"
        desc="settings.allowedHttpHostsDesc"
        overridden={isOverridden(state)("allowedHttpHosts")}
        error={error}
      >
        <Text
          id="allowedHttpHosts"
          rows={4}
          placeholder="gitlab.internal"
          value={(hosts ?? []).join("\n")}
          onReset={() => setError(undefined)}
          onCommit={(text) => {
            const parsed = parseHosts(text);
            if (typeof parsed === "number") {
              setError(t("settings.allowedHttpHostsInvalid", parsed));
              return;
            }
            setError(undefined);
            set("allowedHttpHosts", parsed);
          }}
        />
      </Field>
    </section>
  );
}

export function CommitTab(props: { state: State; loaded: LoadedOptions; load: (agentId: string, model: string) => void }) {
  const { state, loaded, load } = props;
  const overridden = isOverridden(state);
  return (
    <section className="card">
      <AgentModelFields
        id="commit"
        agentKey="commitMessage.agent"
        modelKey="commitMessage.model"
        effortKey="commitMessage.effort"
        fastModeKey="commitMessage.fastMode"
        effortDefault="lowest"
        agentDesc="settings.commitAgentDesc"
        effortDesc="settings.commitEffortDesc"
        state={state}
        loaded={loaded}
        load={load}
      />
      <Field
        id="commit-instructions"
        label="settings.commitInstructions"
        desc="settings.commitInstructionsDesc"
        overridden={overridden("commitMessage.instructions")}
      >
        <Text
          id="commit-instructions"
          rows={5}
          value={stringOf(state, "commitMessage.instructions")}
          onCommit={(s) => set("commitMessage.instructions", s.trim())}
        />
      </Field>
    </section>
  );
}
