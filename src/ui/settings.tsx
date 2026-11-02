import { useEffect, useState, type ReactNode } from "react";
import type { SettingKey } from "../settings";
import type { UsageView } from "../settingsPanel";
import { Icon } from "./icon";
import { useL10n } from "./l10n";
import { mount } from "./mount";
import { EntryList, serversOf } from "./settings/entries";
import { AgentTab, CommitTab, GeneralTab, NotificationsTab, WorktreeTab } from "./settings/panels";
import { post } from "./settings/post";
import { optionsKey, type LoadedOptions, type State } from "./settings/state";
import { TABS, Tabs, type Tab } from "./settings/tabs";
import { UsageTab, type UsageSource } from "./usage";
import { getState, setState as saveState, useMessages } from "./vscode";
import externalIcon from "@tabler/icons/outline/external-link.svg";

type Saved = { tab?: unknown; usageSource?: unknown };

function savedTab(): Tab {
  const state = getState() as Saved | undefined;
  return TABS.find((tab) => tab.id === state?.tab)?.id ?? "general";
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
  const [state, setState] = useState<State>({ values: {}, overridden: [], agents: [] });
  const [loaded, setLoaded] = useState<LoadedOptions>({});
  const [tab, setTab] = useState(savedTab);
  const [usage, setUsage] = useState<UsageView>();
  const [usageSource, setUsageSource] = useState(savedUsageSource);
  const select = (next: Tab) => {
    setTab(next);
    save({ tab: next });
  };

  useMessages((msg) => {
    if (msg.type === "state") setState(msg);
    if (msg.type === "usage") setUsage(msg.usage);
    if (msg.type === "selectTab" && TABS.some((x) => x.id === msg.tab)) select(msg.tab);
    // Answers for an agent no longer selected are dropped.
    if (msg.type === "models") setLoaded((l) => ({ ...l, [optionsKey(msg.agentId, msg.model)]: msg }));
  });
  // After useMessages, so the listener is in place before the extension answers.
  useEffect(() => post({ type: "ready" }), []);

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

      <div className="layout">
        <Tabs active={tab} onSelect={select} badge={badge} />

        <main id="panel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
          <div className="panel-head">
            <h2>{t(current.label)}</h2>
            <div className="desc">{t(current.desc)}</div>
          </div>

          {tab === "general" && <GeneralTab state={state} />}

          {tab === "notifications" && <NotificationsTab state={state} />}

          {tab === "worktree" && <WorktreeTab state={state} />}

          {tab === "agent" && <AgentTab state={state} />}

          {tab === "commit" && <CommitTab state={state} loaded={loaded} load={load} />}

          {tab === "mcp" && <EntryList value={v.mcpServers} overridden={overridden("mcpServers")} />}

          {tab === "custom" && <EntryList agents value={v.customAgents} overridden={overridden("customAgents")} />}

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
        </main>
      </div>
    </>
  );
}

mount(<App />);
