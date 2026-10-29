import { useEffect, useRef, useState, type ReactNode } from "react";
import type { AgentChoice } from "../agentManager";
import type { CommitModel } from "../commitMessage";
import type { FromWebview as SettingsMessage } from "../settingsPanel";
import type { McpServerEntry, SettingKey } from "../settings";
import { Icon } from "./icon";
import { useL10n, type MessageKey } from "./l10n";
import { mount } from "./mount";
import { getState, poster, setState as saveState, useMessages } from "./vscode";
import settingsIcon from "@tabler/icons/outline/settings.svg";
import robotIcon from "@tabler/icons/outline/robot.svg";
import commitIcon from "@tabler/icons/outline/git-commit.svg";
import plugIcon from "@tabler/icons/outline/plug-connected.svg";
import terminalIcon from "@tabler/icons/outline/terminal-2.svg";
import externalIcon from "@tabler/icons/outline/external-link.svg";
import warningIcon from "@tabler/icons/outline/alert-triangle.svg";
import plusIcon from "@tabler/icons/outline/plus.svg";
import pencilIcon from "@tabler/icons/outline/pencil.svg";
import trashIcon from "@tabler/icons/outline/trash.svg";
import serverIcon from "@tabler/icons/outline/server.svg";
import worldIcon from "@tabler/icons/outline/world.svg";

interface State {
  values: Partial<Record<SettingKey, unknown>>;
  overridden: SettingKey[];
  agents: AgentChoice[];
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

/** "KEY=VALUE" lines (or another separator) → object; returns the 1-based number of the first bad line instead. */
function parsePairs(text: string, separator = "="): Record<string, string> | number {
  const result: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const at = line.indexOf(separator);
    if (at <= 0) return i + 1;
    result[line.slice(0, at).trim()] = line.slice(at + separator.length).trim();
  }
  return result;
}

function formatPairs(record: Readonly<Record<string, string>> | undefined, separator = "="): string {
  return Object.entries(record ?? {})
    .map(([k, val]) => `${k}${separator}${val}`)
    .join("\n");
}

function Overridden() {
  const { t } = useL10n();
  return (
    <div className="note warning">
      <Icon svg={warningIcon} />
      {t("settings.overridden")}
    </div>
  );
}

function Field(props: {
  id: string;
  label: MessageKey;
  desc?: MessageKey;
  overridden?: boolean;
  error?: string;
  /** Puts the control beside the label instead of below it (switches). */
  inline?: boolean;
  children: ReactNode;
}) {
  const { t } = useL10n();
  return (
    <div className={props.inline ? "field inline" : "field"}>
      <div className="field-head">
        <label htmlFor={props.id}>{t(props.label)}</label>
        {props.desc && <div className="desc">{t(props.desc)}</div>}
      </div>
      <div className="field-control">{props.children}</div>
      {props.error && <div className="note error">{props.error}</div>}
      {props.overridden && <Overridden />}
    </div>
  );
}

function Toggle(props: { id: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <span className="toggle">
      <input
        id={props.id}
        type="checkbox"
        role="switch"
        checked={props.checked}
        onChange={(e) => props.onChange(e.target.checked)}
      />
      <span className="track" aria-hidden />
    </span>
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

type McpType = "stdio" | "http" | "sse";

/** The editor form of one server; list fields are kept as text until saved. */
interface McpDraft {
  name: string;
  type: McpType;
  command: string;
  args: string;
  env: string;
  url: string;
  headers: string;
}

const EMPTY_DRAFT: McpDraft = { name: "", type: "stdio", command: "", args: "", env: "", url: "", headers: "" };

/** The servers in the setting, skipping entries that are not objects (hand-edited settings.json). */
function serversOf(value: unknown): Array<[string, McpServerEntry]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value).filter(
    (e): e is [string, McpServerEntry] =>
      !!e[1] && typeof e[1] === "object" && (typeof e[1].command === "string" || typeof e[1].url === "string"),
  );
}

function toDraft(name: string, entry: McpServerEntry): McpDraft {
  if ("url" in entry) {
    return { ...EMPTY_DRAFT, name, type: entry.type, url: entry.url, headers: formatPairs(entry.headers, ": ") };
  }
  return {
    ...EMPTY_DRAFT,
    name,
    command: entry.command,
    args: (entry.args ?? []).join("\n"),
    env: formatPairs(entry.env),
  };
}

function isUrl(text: string): boolean {
  try {
    new URL(text);
    return true;
  } catch {
    return false;
  }
}

/** Edits one MCP server or, with `agents`, one custom agent (a local command only). */
function EntryEditor(props: {
  agents?: boolean;
  initial: McpDraft;
  /** Names of the other entries; a saved name must not be one of them. */
  taken: ReadonlyArray<string>;
  onSave: (name: string, entry: McpServerEntry) => void;
  onCancel: () => void;
}) {
  const { t } = useL10n();
  const [draft, setDraft] = useState(props.initial);
  const [error, setError] = useState<string>();
  const edit = (patch: Partial<McpDraft>) => setDraft((d) => ({ ...d, ...patch }));

  const save = () => {
    const name = draft.name.trim();
    if (!name) return setError(t("settings.mcpNameRequired"));
    if (props.taken.includes(name))
      return setError(t(props.agents ? "settings.customNameTaken" : "settings.mcpNameTaken", name));
    if (draft.type === "stdio") {
      const command = draft.command.trim();
      if (!command) return setError(t("settings.mcpCommandRequired"));
      const env = parsePairs(draft.env);
      if (typeof env === "number") return setError(t("settings.mcpEnvInvalid", env));
      const args = draft.args.split(/\r?\n/).filter((l) => l.trim());
      return props.onSave(name, {
        command,
        ...(args.length ? { args } : {}),
        ...(Object.keys(env).length ? { env } : {}),
      });
    }
    const url = draft.url.trim();
    if (!isUrl(url)) return setError(t("settings.mcpUrlInvalid"));
    const headers = parsePairs(draft.headers, ":");
    if (typeof headers === "number") return setError(t("settings.mcpHeadersInvalid", headers));
    props.onSave(name, { type: draft.type, url, ...(Object.keys(headers).length ? { headers } : {}) });
  };

  return (
    <div className="mcp-editor">
      <div className="row">
        <Field id="mcp-name" label="settings.mcpName">
          <input
            id="mcp-name"
            type="text"
            spellCheck={false}
            placeholder={props.agents ? "my-agent" : "github"}
            value={draft.name}
            onChange={(e) => edit({ name: e.target.value })}
          />
        </Field>
        {!props.agents && (
          <Field id="mcp-type" label="settings.mcpType">
            <select id="mcp-type" value={draft.type} onChange={(e) => edit({ type: e.target.value as McpType })}>
              <option value="stdio">{t("settings.mcpTypeStdio")}</option>
              <option value="http">HTTP</option>
              <option value="sse">SSE</option>
            </select>
          </Field>
        )}
      </div>
      {draft.type === "stdio" ? (
        <>
          <Field id="mcp-command" label="settings.command">
            <input
              id="mcp-command"
              type="text"
              spellCheck={false}
              placeholder="npx"
              value={draft.command}
              onChange={(e) => edit({ command: e.target.value })}
            />
          </Field>
          <Field id="mcp-args" label="settings.args" desc="settings.argsDesc">
            <textarea
              id="mcp-args"
              rows={3}
              spellCheck={false}
              placeholder={props.agents ? "--acp" : "-y\n@modelcontextprotocol/server-github"}
              value={draft.args}
              onChange={(e) => edit({ args: e.target.value })}
            />
          </Field>
          <Field id="mcp-env" label="settings.env" desc="settings.mcpEnvDesc">
            <textarea
              id="mcp-env"
              rows={3}
              spellCheck={false}
              placeholder="KEY=VALUE"
              value={draft.env}
              onChange={(e) => edit({ env: e.target.value })}
            />
          </Field>
        </>
      ) : (
        <>
          <Field id="mcp-url" label="settings.mcpUrl" desc="settings.mcpRemoteNote">
            <input
              id="mcp-url"
              type="text"
              spellCheck={false}
              placeholder="https://example.com/mcp"
              value={draft.url}
              onChange={(e) => edit({ url: e.target.value })}
            />
          </Field>
          <Field id="mcp-headers" label="settings.mcpHeaders" desc="settings.mcpHeadersDesc">
            <textarea
              id="mcp-headers"
              rows={3}
              spellCheck={false}
              placeholder="Authorization: Bearer …"
              value={draft.headers}
              onChange={(e) => edit({ headers: e.target.value })}
            />
          </Field>
        </>
      )}
      {error && <div className="note error">{error}</div>}
      <div className="row">
        <button onClick={save}>{t("settings.mcpSave")}</button>
        <button className="secondary" onClick={props.onCancel}>
          {t("settings.mcpCancel")}
        </button>
      </div>
    </div>
  );
}

/** The entries of codeAcp.mcpServers or, with `agents`, of codeAcp.customAgents. */
function EntryList(props: { agents?: boolean; value: unknown; overridden: boolean }) {
  const { t } = useL10n();
  const key = props.agents ? "customAgents" : "mcpServers";
  /** The entry being edited: its name, or "" for a new one. */
  const [editing, setEditing] = useState<string>();
  const servers = serversOf(props.value);
  const names = servers.map(([name]) => name);

  const save = (original: string, name: string, entry: McpServerEntry) => {
    // Keeps the server's place in the list when it is renamed.
    const next: Record<string, McpServerEntry> = {};
    for (const [key, value] of servers) next[key === original ? name : key] = key === original ? entry : value;
    if (!original) next[name] = entry;
    set(key, next);
    setEditing(undefined);
  };
  const remove = (name: string) => set(key, Object.fromEntries(servers.filter(([other]) => other !== name)));

  return (
    <>
      {props.overridden && <Overridden />}
      <div className="mcp-list">
        {!servers.length && editing === undefined && (
          <div className="note">{t(props.agents ? "settings.customEmpty" : "settings.mcpEmpty")}</div>
        )}
        {servers.map(([name, entry]) =>
          editing === name ? (
            <EntryEditor
              key={name}
              agents={props.agents}
              initial={toDraft(name, entry)}
              taken={names.filter((n) => n !== name)}
              onSave={(newName, newEntry) => save(name, newName, newEntry)}
              onCancel={() => setEditing(undefined)}
            />
          ) : (
            <div key={name} className="mcp-row">
              <span className="mcp-icon">
                <Icon svg={props.agents ? terminalIcon : "url" in entry ? worldIcon : serverIcon} />
              </span>
              <div className="mcp-info">
                <div>
                  <strong>{name}</strong>{" "}
                  {!props.agents && (
                    <span className="badge">{"url" in entry ? entry.type.toUpperCase() : "stdio"}</span>
                  )}
                </div>
                <code>{"url" in entry ? entry.url : [entry.command, ...(entry.args ?? [])].join(" ")}</code>
              </div>
              <button
                className="icon-btn"
                title={t("settings.mcpEdit")}
                aria-label={t("settings.mcpEdit")}
                disabled={editing !== undefined}
                onClick={() => setEditing(name)}
              >
                <Icon svg={pencilIcon} />
              </button>
              <button
                className="icon-btn danger"
                title={t("settings.mcpRemove")}
                aria-label={t("settings.mcpRemove")}
                disabled={editing !== undefined}
                onClick={() => remove(name)}
              >
                <Icon svg={trashIcon} />
              </button>
            </div>
          ),
        )}
        {editing === "" && (
          <EntryEditor
            agents={props.agents}
            initial={EMPTY_DRAFT}
            taken={names}
            onSave={(name, entry) => save("", name, entry)}
            onCancel={() => setEditing(undefined)}
          />
        )}
      </div>
      {editing === undefined && (
        <button className="with-icon" onClick={() => setEditing("")}>
          <Icon svg={plusIcon} />
          {t(props.agents ? "settings.customAdd" : "settings.mcpAdd")}
        </button>
      )}
      <div className="note muted">{t("settings.mcpSecretNote")}</div>
    </>
  );
}

type Tab = "general" | "agent" | "commit" | "mcp" | "custom";

const TABS: ReadonlyArray<{ id: Tab; label: MessageKey; desc: MessageKey; icon: string; keys: SettingKey[] }> = [
  { id: "general", label: "settings.general", desc: "settings.generalDesc", icon: settingsIcon, keys: ["language", "followAgent", "autoScroll"] },
  {
    id: "agent",
    label: "settings.agent",
    desc: "settings.agentDesc",
    icon: robotIcon,
    keys: ["checkAgentUpdates", "nodePath", "env"],
  },
  {
    id: "commit",
    label: "settings.commit",
    desc: "settings.commitDesc",
    icon: commitIcon,
    keys: ["commitMessage.agent", "commitMessage.model", "commitMessage.instructions"],
  },
  { id: "mcp", label: "settings.mcp", desc: "settings.mcpDesc", icon: plugIcon, keys: ["mcpServers"] },
  {
    id: "custom",
    label: "settings.custom",
    desc: "settings.customDesc",
    icon: terminalIcon,
    keys: ["customAgents"],
  },
];

function savedTab(): Tab {
  const state = getState() as { tab?: unknown } | undefined;
  return TABS.find((tab) => tab.id === state?.tab)?.id ?? "general";
}

function Tabs(props: { active: Tab; onSelect: (tab: Tab) => void; badge: (tab: Tab) => ReactNode }) {
  const { t } = useL10n();
  const refs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});
  const move = (delta: number) => {
    const i = TABS.findIndex((tab) => tab.id === props.active);
    const next = TABS[(i + delta + TABS.length) % TABS.length].id;
    props.onSelect(next);
    refs.current[next]?.focus();
  };
  return (
    <nav
      className="tabs"
      role="tablist"
      aria-label={t("settings.sections")}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight" || e.key === "ArrowDown") move(1);
        else if (e.key === "ArrowLeft" || e.key === "ArrowUp") move(-1);
        else return;
        e.preventDefault();
      }}
    >
      {TABS.map((tab) => (
        <button
          key={tab.id}
          ref={(el) => {
            refs.current[tab.id] = el;
          }}
          id={`tab-${tab.id}`}
          role="tab"
          className="tab"
          aria-selected={props.active === tab.id}
          aria-controls="panel"
          tabIndex={props.active === tab.id ? 0 : -1}
          onClick={() => props.onSelect(tab.id)}
        >
          <Icon svg={tab.icon} />
          <span className="tab-label">{t(tab.label)}</span>
          {props.badge(tab.id)}
        </button>
      ))}
    </nav>
  );
}

function App() {
  const { t } = useL10n();
  const [state, setState] = useState<State>({ values: {}, overridden: [], agents: [] });
  const [envError, setEnvError] = useState<string>();
  const [models, setModels] = useState<Models>();
  const [tab, setTab] = useState(savedTab);
  const select = (next: Tab) => {
    setTab(next);
    saveState({ tab: next });
  };

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
  const env = formatPairs(v.env as Record<string, string> | undefined);
  const commitAgent = str("commitMessage.agent");
  const commitModel = str("commitMessage.model");
  const loaded = models?.agentId === commitAgent ? models : undefined;
  const loadModels = () => {
    setModels({ agentId: commitAgent });
    post({ type: "loadModels", agentId: commitAgent });
  };
  const mcpCount = serversOf(v.mcpServers).length;
  const customCount = serversOf(v.customAgents).length;
  const badge = (id: Tab): ReactNode => {
    if (TABS.find((x) => x.id === id)!.keys.some(overridden)) return <span className="dot warning" />;
    if (id === "mcp" && mcpCount) return <span className="count">{mcpCount}</span>;
    if (id === "custom" && customCount) return <span className="count">{customCount}</span>;
    return null;
  };
  const current = TABS.find((x) => x.id === tab)!;

  return (
    <>
      <header>
        <h1>{t("settings.title")}</h1>
        <button className="secondary with-icon" onClick={() => post({ type: "openNative" })}>
          <Icon svg={externalIcon} />
          {t("settings.openNative")}
        </button>
      </header>

      <Tabs active={tab} onSelect={select} badge={badge} />

      <main id="panel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
        <div className="panel-head">
          <h2>{t(current.label)}</h2>
          <div className="desc">{t(current.desc)}</div>
        </div>

        {tab === "general" && (
          <section className="card">
            <Field
              id="language"
              label="settings.language"
              desc="settings.languageDesc"
              overridden={overridden("language")}
            >
              <select id="language" value={str("language", "auto")} onChange={(e) => set("language", e.target.value)}>
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
          </section>
        )}

        {tab === "agent" && (
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
                value={str("nodePath")}
                onCommit={(s) => set("nodePath", s.trim())}
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
        )}

        {tab === "commit" && (
          <section className="card">
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
                    {a.version ? `${a.name} ${a.version}` : a.name}
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
                <select
                  id="commit-model"
                  value={commitModel}
                  onChange={(e) => set("commitMessage.model", e.target.value)}
                >
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
        )}

        {tab === "mcp" && <EntryList value={v.mcpServers} overridden={overridden("mcpServers")} />}

        {tab === "custom" && <EntryList agents value={v.customAgents} overridden={overridden("customAgents")} />}
      </main>
    </>
  );
}

mount(<App />);
