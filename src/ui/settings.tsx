import { useEffect, useState, type ReactNode } from "react";
import type { CatalogState } from "../agentCatalog";
import type { DoctorState } from "../doctor";
import type { SettingKey } from "../settings";
import type { UsageView } from "../settingsPanel";
import { Icon } from "./icon";
import { useL10n } from "./l10n";
import { mount } from "./mount";
import { AgentCatalogTab } from "./settings/catalog";
import { DoctorTab } from "./settings/doctor";
import { EntryList, serversOf } from "./settings/entries";
import { ScopeContext, Segmented } from "./settings/fields";
import { AgentTab, CommitTab, GeneralTab, LanguageTab, LinksTab, NotificationsTab, PermissionsTab, TracingTab, WorktreeTab } from "./settings/panels";
import { post } from "./settings/post";
import { optionsKey, type LoadedOptions, type State } from "./settings/state";
import { SubTabs, TABS, Tabs, type Tab } from "./settings/tabs";
import { UsageTab, type UsageSource } from "./usage";
import { getState, setState as saveState, useMessages } from "./vscode";
import externalIcon from "@tabler/icons/outline/external-link.svg";
import folderIcon from "@tabler/icons/outline/folder.svg";

type Saved = { tab?: unknown; agentSection?: unknown; usageSource?: unknown };

const AGENT_SECTIONS = ["general", "manage", "custom"] as const;
type AgentSection = (typeof AGENT_SECTIONS)[number];

const agentSectionOf = (value: unknown): AgentSection | undefined => AGENT_SECTIONS.find((section) => section === value);

function savedTab(): Tab {
  const state = getState() as Saved | undefined;
  return TABS.find((tab) => tab.id === state?.tab)?.id ?? "general";
}

function savedAgentSection(): AgentSection {
  return agentSectionOf((getState() as Saved | undefined)?.agentSection) ?? "general";
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
  const [state, setState] = useState<State>({ values: {}, overridden: [], workspaceAutoApprove: {}, scope: "user", hasWorkspace: false, locked: [], agents: [] });
  const [loaded, setLoaded] = useState<LoadedOptions>({});
  const [tab, setTab] = useState(savedTab);
  const [agentSection, setAgentSection] = useState(savedAgentSection);
  const [catalog, setCatalog] = useState<CatalogState>({ agents: [], loading: true });
  const [doctor, setDoctor] = useState<DoctorState>({ rows: [], running: false });
  const [usage, setUsage] = useState<UsageView>();
  const [usageSource, setUsageSource] = useState(savedUsageSource);
  const select = (next: Tab) => {
    setTab(next);
    save({ tab: next });
  };
  const selectAgentSection = (next: AgentSection) => {
    setAgentSection(next);
    save({ agentSection: next });
  };

  useMessages((msg) => {
    if (msg.type === "state") setState(msg);
    if (msg.type === "usage") setUsage(msg.usage);
    if (msg.type === "catalog") setCatalog(msg.catalog);
    if (msg.type === "doctor") setDoctor(msg.doctor);
    if (msg.type === "selectTab" && TABS.some((x) => x.id === msg.tab)) {
      select(msg.tab);
      const section = agentSectionOf(msg.section);
      if (section) selectAgentSection(section);
      if (msg.tab === "doctor" && msg.section === "run") post({ type: "doctorRun" });
    }
    // Answers for an agent no longer selected are dropped.
    if (msg.type === "models") setLoaded((l) => ({ ...l, [optionsKey(msg.agentId, msg.model)]: msg }));
  });
  // After useMessages, so the listener is in place before the extension answers.
  useEffect(() => post({ type: "ready" }), []);
  const onCatalog = tab === "agent" && agentSection === "manage";
  // The registry is only fetched for those who look at it.
  useEffect(() => {
    if (onCatalog) post({ type: "catalogLoad" });
  }, [onCatalog]);

  const v = state.values;
  const overridden = (key: SettingKey) => state.overridden.includes(key);
  const load = (agentId: string, model: string) => {
    setLoaded((l) => ({ ...l, [optionsKey(agentId, model)]: { agentId, model } }));
    post({ type: "loadModels", agentId, model });
  };
  const mcpCount = serversOf(v.mcpServers).length;
  const customCount = serversOf(v.customAgents).length;
  const badge = (id: Tab): ReactNode => {
    if (TABS.find((x) => x.id === id)!.keys.some(overridden)) return <span className="dot warning" />;
    if (id === "mcp" && mcpCount) return <span className="count">{mcpCount}</span>;
    return null;
  };
  const current = TABS.find((x) => x.id === tab)!;
  // Usage, Doctor and the installed agents are no settings.
  const scoped = current.keys.length > 0 && !onCatalog;
  const panelDesc = tab !== "agent" || agentSection === "general" ? current.desc : agentSection === "manage" ? "settings.manageDesc" : "settings.customDesc";
  const workspaceLabel = state.workspaceName ? t("settings.scopeWorkspaceNamed", state.workspaceName) : t("settings.scopeWorkspace");
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
              { value: "workspace", label: workspaceLabel, title: scopeTitle(`${workspaceLabel}\n${t("settings.scopeWorkspaceDesc")}`) },
            ]}
            onChange={(scope) => post({ type: "scope", scope: scope === "workspace" ? "workspace" : "user" })}
          />
        )}
        <button className="open-native with-icon" aria-label={t("settings.openNative")} title={t("settings.openNative")} onClick={() => post({ type: "openNative" })}>
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

          {tab === "language" && <LanguageTab state={state} />}

          {tab === "notifications" && <NotificationsTab state={state} />}

          {tab === "permissions" && <PermissionsTab state={state} />}

          {tab === "worktree" && <WorktreeTab state={state} />}

          {tab === "agent" && (
            <>
              <SubTabs
                label={t("settings.agentSections")}
                active={agentSection}
                tabs={[
                  { id: "general", label: t("settings.general") },
                  { id: "manage", label: t("settings.manageAgents") },
                  {
                    id: "custom",
                    label: t("settings.custom"),
                    badge: overridden("customAgents") ? <span className="dot warning" /> : customCount > 0 && <span className="count">{customCount}</span>,
                  },
                ]}
                onSelect={selectAgentSection}
              />
              <div id="subpanel" role="tabpanel" aria-labelledby={`subtab-${agentSection}`}>
                {agentSection === "general" ? (
                  <AgentTab state={state} loaded={loaded} load={load} />
                ) : agentSection === "manage" ? (
                  <AgentCatalogTab catalog={catalog} />
                ) : (
                  <EntryList agents value={v.customAgents} overridden={overridden("customAgents")} locked={state.locked.includes("customAgents")} />
                )}
              </div>
            </>
          )}

          {tab === "commit" && <CommitTab state={state} loaded={loaded} load={load} />}

          {tab === "mcp" && <EntryList value={v.mcpServers} overridden={overridden("mcpServers")} locked={state.locked.includes("mcpServers")} />}

          {tab === "links" && <LinksTab state={state} />}

          {tab === "tracing" && <TracingTab state={state} />}

          {tab === "usage" && <UsageTab
              source={usageSource}
              onSource={(next) => {
                setUsageSource(next);
                save({ usageSource: next });
              }}
              usage={usage}
              onClear={() => post({ type: "clearUsage" })}
              onQuery={(text, limit) => post({ type: "usageQuery", text, limit })}
              onCcusage={(source, refresh) => post({ type: "ccusage", source, refresh })}
            />}

          {tab === "doctor" && <DoctorTab doctor={doctor} />}
        </main>
      </div>
    </ScopeContext.Provider>
  );
}

mount(<App />);
