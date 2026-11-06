import { useEffect, useState, type ReactNode } from "react";
import type { CatalogState } from "../agentCatalog";
import type { DoctorState } from "../doctor";
import type { SettingKey } from "../settings";
import type { UsageView } from "../settingsPanel";
import { Icon } from "./icon";
import { useL10n } from "./l10n";
import { mount } from "./mount";
import { EntryList, serversOf } from "./settings/entries";
import { ADD_VIEW, ProvidersTab, type AddSection, type ProviderView } from "./settings/providers";
import { ScopeContext, Segmented } from "./settings/fields";
import {
  DebugTab,
  DisplayTab,
  GeneralTab,
  LanguageTab,
  AllowedHostsCard,
  NotificationsTab,
  PermissionsTab,
  GitTab,
} from "./settings/panels";
import { post } from "./settings/post";
import { optionsKey, type LoadedOptions, type State } from "./settings/state";
import { TABS, Tabs, type Tab } from "./settings/tabs";
import { UsageTab, type UsageSource } from "./usage";
import { getState, setState as saveState, useMessages } from "./vscode";
import externalIcon from "@tabler/icons/outline/external-link.svg";
import folderIcon from "@tabler/icons/outline/folder.svg";

type Saved = { tab?: unknown; provider?: unknown; addSection?: unknown; usageSource?: unknown };

function savedTab(): Tab {
  const state = getState() as Saved | undefined;
  // The Agent tab of earlier versions is the Providers tab.
  if (state?.tab === "agent") return "providers";
  // The Links tab of earlier versions is part of the Permissions tab.
  if (state?.tab === "links") return "permissions";
  // The Worktree and Commit messages tabs of earlier versions are the Git tab.
  if (state?.tab === "worktree" || state?.tab === "commit") return "git";
  // The Tracing and Doctor tabs of earlier versions are the Debug tab.
  if (state?.tab === "tracing" || state?.tab === "doctor") return "debug";
  return TABS.find((tab) => tab.id === state?.tab)?.id ?? "general";
}

function savedProvider(): ProviderView {
  const provider = (getState() as Saved | undefined)?.provider;
  return typeof provider === "string" ? provider : "";
}

function savedAddSection(): AddSection {
  return (getState() as Saved | undefined)?.addSection === "custom" ? "custom" : "registry";
}

function savedUsageSource(): UsageSource {
  return (getState() as Saved | undefined)?.usageSource === "ccusage" ? "ccusage" : "ledger";
}

/** Keeps `patch` in the webview's saved state, beside what is there. */
function save(patch: Saved): void {
  saveState({ ...(getState() as Saved | undefined), ...patch });
}

function App() {
  const { t } = useL10n();
  const [state, setState] = useState<State>({
    values: {},
    overridden: [],
    workspaceAutoApprove: {},
    scope: "user",
    hasWorkspace: false,
    locked: [],
    agents: [],
    providers: [],
  });
  const [loaded, setLoaded] = useState<LoadedOptions>({});
  const [tab, setTab] = useState(savedTab);
  const [provider, setProvider] = useState(savedProvider);
  const [addSection, setAddSection] = useState(savedAddSection);
  const [catalog, setCatalog] = useState<CatalogState>({ agents: [], loading: true });
  const [doctor, setDoctor] = useState<DoctorState>({ rows: [], running: false });
  const [usage, setUsage] = useState<UsageView>();
  const [usageSource, setUsageSource] = useState(savedUsageSource);
  const select = (next: Tab) => {
    setTab(next);
    save({ tab: next });
  };
  const selectProvider = (next: ProviderView) => {
    setProvider(next);
    save({ provider: next });
  };
  const selectAddSection = (next: AddSection) => {
    setAddSection(next);
    save({ addSection: next });
  };

  useMessages((msg) => {
    if (msg.type === "state") setState(msg);
    if (msg.type === "usage") setUsage(msg.usage);
    if (msg.type === "catalog") setCatalog(msg.catalog);
    if (msg.type === "doctor") setDoctor(msg.doctor);
    if (msg.type === "selectTab" && TABS.some((x) => x.id === msg.tab)) {
      select(msg.tab);
      if (msg.tab === "providers" && msg.section === "add") selectProvider(ADD_VIEW);
      if (msg.tab === "debug" && msg.section === "doctor") post({ type: "doctorRun" });
    }
    // Answers for an agent no longer selected are dropped.
    if (msg.type === "models") setLoaded((l) => ({ ...l, [optionsKey(msg.agentId, msg.model)]: msg }));
  });
  // After useMessages, so the listener is in place before the extension answers.
  useEffect(() => post({ type: "ready" }), []);
  const onProviders = tab === "providers";
  // The registry is only fetched for those who look at it: for its agents, and the updates of those installed.
  useEffect(() => {
    if (onProviders) post({ type: "catalogLoad" });
  }, [onProviders]);

  const v = state.values;
  const overridden = (key: SettingKey) => state.overridden.includes(key);
  const load = (agentId: string, model: string) => {
    setLoaded((l) => ({ ...l, [optionsKey(agentId, model)]: { agentId, model } }));
    post({ type: "loadModels", agentId, model });
  };
  const mcpCount = serversOf(v.mcpServers).length;
  const badge = (id: Tab): ReactNode => {
    if (TABS.find((x) => x.id === id)!.keys.some(overridden)) return <span className="dot warning" />;
    if (id === "mcp" && mcpCount) return <span className="count">{mcpCount}</span>;
    if (id === "providers" && state.providers.length) return <span className="count">{state.providers.length}</span>;
    return null;
  };
  const current = TABS.find((x) => x.id === tab)!;
  // Usage is no settings.
  const scoped = current.keys.length > 0;
  const panelDesc = current.desc;
  const workspaceLabel = state.workspaceName
    ? t("settings.scopeWorkspaceNamed", state.workspaceName)
    : t("settings.scopeWorkspace");
  // A disabled option says why; a long workspace name is cut off, so the workspace's says it in full.
  const scopeTitle = (desc: string) => (scoped ? desc : t("settings.scopeNotApplicable"));

  return (
    <ScopeContext.Provider value={state.scope}>
      <header>
        <h1>{t("settings.title")}</h1>
        {state.hasWorkspace && (
          <Segmented
            id="scope"
            className="scope-switch"
            label={t("settings.scope")}
            value={state.scope}
            disabled={!scoped}
            options={[
              { value: "user", label: t("settings.scopeUser"), title: scopeTitle(t("settings.scopeUserDesc")) },
              {
                value: "workspace",
                label: workspaceLabel,
                title: scopeTitle(`${workspaceLabel}\n${t("settings.scopeWorkspaceDesc")}`),
              },
            ]}
            onChange={(scope) => post({ type: "scope", scope: scope === "workspace" ? "workspace" : "user" })}
          />
        )}
        <button
          className="open-native with-icon"
          aria-label={t("settings.openNative")}
          title={t("settings.openNative")}
          onClick={() => post({ type: "openNative" })}
        >
          <Icon svg={externalIcon} />
          <span className="open-native-label">{t("settings.openNative")}</span>
        </button>
      </header>

      <div className="layout">
        <Tabs active={tab} onSelect={select} badge={badge} />

        <main id="panel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
          <div className="panel-head">
            <h2>{t(current.label)}</h2>
            <div className="desc">{t(panelDesc)}</div>
          </div>
          {state.scope === "workspace" && scoped && (
            <div className="scope-bar" role="status">
              <Icon svg={folderIcon} />
              {t("settings.scopeWorkspaceNote")}
            </div>
          )}

          {tab === "general" && <GeneralTab state={state} />}

          {tab === "display" && <DisplayTab state={state} />}

          {tab === "language" && <LanguageTab state={state} />}

          {tab === "notifications" && <NotificationsTab state={state} />}

          {tab === "permissions" && (
            <>
              <PermissionsTab state={state} />
              <AllowedHostsCard state={state} />
            </>
          )}

          {tab === "git" && <GitTab state={state} loaded={loaded} load={load} />}

          {tab === "providers" && (
            <ProvidersTab
              state={state}
              catalog={catalog}
              doctor={doctor}
              loaded={loaded}
              load={load}
              view={provider}
              onView={selectProvider}
              addSection={addSection}
              onAddSection={selectAddSection}
            />
          )}

          {tab === "mcp" && (
            <EntryList
              value={v.mcpServers}
              overridden={overridden("mcpServers")}
              locked={state.locked.includes("mcpServers")}
            />
          )}

          {tab === "usage" && (
            <UsageTab
              source={usageSource}
              onSource={(next) => {
                setUsageSource(next);
                save({ usageSource: next });
              }}
              usage={usage}
              onClear={() => post({ type: "clearUsage" })}
              onQuery={(text, limit) => post({ type: "usageQuery", text, limit })}
              onCcusage={(source, refresh) => post({ type: "ccusage", source, refresh })}
            />
          )}

          {tab === "debug" && <DebugTab state={state} doctor={doctor} />}
        </main>
      </div>
    </ScopeContext.Provider>
  );
}

mount(<App />);
