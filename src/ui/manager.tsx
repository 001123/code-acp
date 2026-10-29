import { useEffect, useState } from "react";
import type { FromWebview as ManagerMessage } from "../managerPanel";
import { useL10n } from "./l10n";
import { mount } from "./mount";
import { poster, useMessages } from "./vscode";

interface Agent {
  id: string;
  name: string;
  version: string;
  description: string;
  icon?: string;
  url?: string;
  license?: string;
  kind?: "npx" | "uvx" | "binary";
  installedVersion?: string;
  active: boolean;
  busy?: string;
}

interface State {
  agents: Agent[];
  loading: boolean;
  error?: string;
}

const post = poster<ManagerMessage>();

const KIND_LABEL = { npx: "npm", uvx: "uv", binary: "binary" };

function Card({ agent: a }: { agent: Agent }) {
  const { t } = useL10n();
  return (
    <div className={"card" + (a.active ? " active" : "")}>
      <div className="icon" style={a.icon ? { maskImage: `url("${a.icon}")` } : undefined} />
      <div className="body">
        <div className="title">
          <span className="name">{a.name}</span>
          <span className="version">{a.version}</span>
          {a.kind && <span className="badge">{KIND_LABEL[a.kind]}</span>}
          {a.active && <span className="badge active">{t("manager.active")}</span>}
        </div>
        <div className="desc">{a.description}</div>
        <div className="meta">
          {a.license && <span>{a.license}</span>}
          {a.url && (
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                post({ type: "open", url: a.url! });
              }}
            >
              {a.url.replace(/^https:\/\//, "")}
            </a>
          )}
        </div>
      </div>
      <div className="actions">
        {a.busy ? (
          <span className="busy">{a.busy}</span>
        ) : !a.kind ? (
          <span className="muted">{t("manager.unsupported")}</span>
        ) : a.installedVersion ? (
          <>
            {!a.active && <button onClick={() => post({ type: "use", id: a.id })}>{t("manager.use")}</button>}
            {a.installedVersion !== a.version && (
              <button onClick={() => post({ type: "install", id: a.id })}>
                {t("manager.update", a.installedVersion, a.version)}
              </button>
            )}
            <button className="secondary" onClick={() => post({ type: "uninstall", id: a.id })}>
              {t("manager.uninstall")}
            </button>
          </>
        ) : (
          <button onClick={() => post({ type: "install", id: a.id })}>{t("manager.install")}</button>
        )}
      </div>
    </div>
  );
}

function App() {
  const { t } = useL10n();
  const [state, setState] = useState<State>({ agents: [], loading: false });
  const [query, setQuery] = useState("");
  const [installedOnly, setInstalledOnly] = useState(false);

  useMessages((msg) => {
    if (msg.type === "state") setState(msg);
  });
  // After useMessages, so the listener is in place before the extension answers.
  useEffect(() => post({ type: "ready" }), []);

  const q = query.trim().toLowerCase();
  const agents = state.agents
    .filter((a) => !installedOnly || a.installedVersion)
    .filter((a) => !q || `${a.name} ${a.id} ${a.description}`.toLowerCase().includes(q))
    // Installed agents first, then by name.
    .sort((x, y) => Number(!!y.installedVersion) - Number(!!x.installedVersion) || x.name.localeCompare(y.name));

  return (
    <>
      <header>
        <h1>ACP Agents</h1>
        <input
          id="search"
          type="search"
          placeholder={t("manager.search")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <label>
          <input type="checkbox" checked={installedOnly} onChange={(e) => setInstalledOnly(e.target.checked)} />{" "}
          <span>{t("manager.installedOnly")}</span>
        </label>
        <button className="secondary" disabled={state.loading} onClick={() => post({ type: "refresh" })}>
          {state.loading ? t("manager.loading") : t("manager.refresh")}
        </button>
      </header>
      <div id="error" hidden={!state.error}>
        {state.error}
      </div>
      <div id="list">
        {agents.map((a) => (
          <Card key={a.id} agent={a} />
        ))}
        {!agents.length && !state.loading && <div className="muted">{t("manager.empty")}</div>}
      </div>
    </>
  );
}

mount(<App />);
