import { useEffect, useRef, useState, type ReactNode } from "react";
import type { CommitModel } from "../commitMessage";
import type { FromWebview as SettingsMessage } from "../settingsPanel";
import type { SettingKey } from "../settings";
import { useL10n, type MessageKey } from "./l10n";
import { mount } from "./mount";
import { poster, useMessages } from "./vscode";

interface State {
  values: Partial<Record<SettingKey, unknown>>;
  overridden: SettingKey[];
  agents: { id: string; name: string; version: string }[];
  activeId?: string;
}

/** Models loaded for the commit agent `agentId`; undefined `models` while loading. */
interface Models {
  agentId: string;
  models?: ReadonlyArray<CommitModel>;
  error?: string;
}

const post = poster<SettingsMessage>();

function set(key: SettingKey, value: unknown): void {
  post({ type: "set", key, value });
}

/** "KEY=VALUE" lines → object; returns the 1-based number of the first bad line instead. */
function parseEnv(text: string): Record<string, string> | number {
  const result: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) return i + 1;
    result[line.slice(0, eq).trim()] = line.slice(eq + 1);
  }
  return result;
}

function Field(props: {
  id: string;
  label: MessageKey;
  desc?: MessageKey;
  overridden?: boolean;
  error?: string;
  children: ReactNode;
}) {
  const { t } = useL10n();
  return (
    <div className="field">
      <label htmlFor={props.id}>{t(props.label)}</label>
      {props.desc && <div className="desc">{t(props.desc)}</div>}
      {props.children}
      {props.error && <div className="note error">{props.error}</div>}
      {props.overridden && <div className="note warning">{t("settings.overridden")}</div>}
    </div>
  );
}

/**
 * A text input or textarea that commits on blur (and Enter for inputs), so typing is never
 * interrupted by a re-render. Outside values only replace the text while it is not focused.
 */
function Text(props: {
  id: string;
  value: string;
  onCommit: (text: string) => void;
  /** Called when an outside value replaces the text. */
  onReset?: () => void;
  rows?: number;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState(props.value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) {
      setDraft(props.value);
      props.onReset?.();
    }
  }, [props.value]);

  const common = {
    id: props.id,
    value: draft,
    spellCheck: false,
    placeholder: props.placeholder,
    onFocus: () => (focused.current = true),
    onBlur: () => {
      focused.current = false;
      if (draft !== props.value) props.onCommit(draft);
    },
  };
  return props.rows ? (
    <textarea {...common} rows={props.rows} onChange={(e) => setDraft(e.target.value)} />
  ) : (
    <input
      {...common}
      type="text"
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && draft !== props.value) props.onCommit(draft);
      }}
    />
  );
}

function App() {
  const { t } = useL10n();
  const [state, setState] = useState<State>({ values: {}, overridden: [], agents: [] });
  const [envError, setEnvError] = useState<string>();
  const [models, setModels] = useState<Models>();

  useMessages((msg) => {
    if (msg.type === "state") setState(msg);
    // Answers for an agent no longer selected are dropped.
    if (msg.type === "models") setModels((m) => (m?.agentId === msg.agentId ? msg : m));
  });
  // After useMessages, so the listener is in place before the extension answers.
  useEffect(() => post({ type: "ready" }), []);

  const v = state.values;
  const str = (key: SettingKey, fallback = "") => (typeof v[key] === "string" ? (v[key] as string) : fallback);
  const overridden = (key: SettingKey) => state.overridden.includes(key);
  const env = Object.entries((v.env ?? {}) as Record<string, string>)
    .map(([k, val]) => `${k}=${val}`)
    .join("\n");
  const args = ((v.agentArgs ?? []) as string[]).join("\n");
  const commitAgent = str("commitMessage.agent");
  const commitModel = str("commitMessage.model");
  const loaded = models?.agentId === commitAgent ? models : undefined;
  const loadModels = () => {
    setModels({ agentId: commitAgent });
    post({ type: "loadModels", agentId: commitAgent });
  };

  return (
    <>
      <header>
        <h1>{t("settings.title")}</h1>
        <button className="secondary" onClick={() => post({ type: "openNative" })}>
          {t("settings.openNative")}
        </button>
      </header>

      <section>
        <h2>{t("settings.general")}</h2>
        <Field id="language" label="settings.language" desc="settings.languageDesc" overridden={overridden("language")}>
          <select id="language" value={str("language", "auto")} onChange={(e) => set("language", e.target.value)}>
            <option value="auto">{t("settings.languageAuto")}</option>
            <option value="en">English</option>
            <option value="vi">Tiếng Việt</option>
          </select>
        </Field>
      </section>

      <section>
        <h2>{t("settings.agent")}</h2>
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
                  {a.name} {a.version}
                </option>
              ))}
            </select>
            <button className="secondary" onClick={() => post({ type: "manageAgents" })}>
              {t("settings.manageAgents")}
            </button>
          </div>
        </Field>
        <Field id="nodePath" label="settings.nodePath" desc="settings.nodePathDesc" overridden={overridden("nodePath")}>
          <Text id="nodePath" placeholder="node" value={str("nodePath")} onCommit={(s) => set("nodePath", s.trim())} />
        </Field>
        <Field id="env" label="settings.env" desc="settings.envDesc" overridden={overridden("env")} error={envError}>
          <Text
            id="env"
            rows={4}
            placeholder="KEY=VALUE"
            value={env}
            onReset={() => setEnvError(undefined)}
            onCommit={(text) => {
              const parsed = parseEnv(text);
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

      <section>
        <h2>{t("settings.commit")}</h2>
        <Field
          id="commit-agent"
          label="settings.commitAgent"
          desc="settings.commitAgentDesc"
          overridden={overridden("commitMessage.agent")}
        >
          <select
            id="commit-agent"
            value={commitAgent}
            onChange={(e) => {
              set("commitMessage.agent", e.target.value);
              // Another agent's models don't apply.
              set("commitMessage.model", "");
            }}
          >
            <option value="">{t("settings.commitAgentDefault")}</option>
            {state.agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} {a.version}
              </option>
            ))}
            {commitAgent && !state.agents.some((a) => a.id === commitAgent) && (
              <option value={commitAgent}>{commitAgent}</option>
            )}
          </select>
        </Field>
        <Field
          id="commit-model"
          label="settings.commitModel"
          desc="settings.commitModelDesc"
          overridden={overridden("commitMessage.model")}
          error={loaded?.error}
        >
          <div className="row">
            <select id="commit-model" value={commitModel} onChange={(e) => set("commitMessage.model", e.target.value)}>
              <option value="">{t("settings.commitModelDefault")}</option>
              {loaded?.models?.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.name}
                </option>
              ))}
              {commitModel && !loaded?.models?.some((m) => m.value === commitModel) && (
                <option value={commitModel}>{commitModel}</option>
              )}
            </select>
            <button className="secondary" disabled={!!loaded && !loaded.models} onClick={loadModels}>
              {loaded && !loaded.models ? t("settings.loadingModels") : t("settings.loadModels")}
            </button>
          </div>
          {loaded?.models?.length === 0 && !loaded.error && <div className="note">{t("settings.noModels")}</div>}
        </Field>
        <Field
          id="commit-instructions"
          label="settings.commitInstructions"
          desc="settings.commitInstructionsDesc"
          overridden={overridden("commitMessage.instructions")}
        >
          <Text
            id="commit-instructions"
            rows={5}
            value={str("commitMessage.instructions")}
            onCommit={(s) => set("commitMessage.instructions", s.trim())}
          />
        </Field>
      </section>

      <section>
        <h2>{t("settings.custom")}</h2>
        <div className="desc">{t("settings.customDesc")}</div>
        <Field id="agentCommand" label="settings.command" overridden={overridden("agentCommand")}>
          <Text id="agentCommand" value={str("agentCommand")} onCommit={(s) => set("agentCommand", s.trim())} />
        </Field>
        <Field id="agentArgs" label="settings.args" desc="settings.argsDesc" overridden={overridden("agentArgs")}>
          <Text
            id="agentArgs"
            rows={3}
            value={args}
            onCommit={(s) =>
              set(
                "agentArgs",
                s.split(/\r?\n/).filter((l) => l.trim()),
              )
            }
          />
        </Field>
      </section>
    </>
  );
}

mount(<App />);
