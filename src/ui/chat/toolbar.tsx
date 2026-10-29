import type * as acp from "@agentclientprotocol/sdk";
import type { TabInfo, WorkspaceFolderInfo } from "../../chat/protocol";
import { Icon } from "../icon";
import { useL10n } from "../l10n";
import adjustmentsIcon from "@tabler/icons/outline/adjustments.svg";
import boltIcon from "@tabler/icons/outline/bolt.svg";
import brainIcon from "@tabler/icons/outline/brain.svg";
import cpuIcon from "@tabler/icons/outline/cpu.svg";
import folderIcon from "@tabler/icons/outline/folder.svg";
import robotIcon from "@tabler/icons/outline/robot.svg";
import shieldIcon from "@tabler/icons/outline/shield-half.svg";
import { post } from "./post";

/** Icon for a config option: by its ACP category, else by keywords in its id or name. */
function configIcon(option: acp.SessionConfigOption): string {
  switch (option.category) {
    case "mode":
      return shieldIcon;
    case "model":
      return cpuIcon;
    case "thought_level":
      return brainIcon;
  }
  const key = `${option.id} ${option.name}`.toLowerCase();
  if (/mode|permission/.test(key) && !/fast/.test(key)) return shieldIcon;
  if (/model/.test(key)) return cpuIcon;
  if (/effort|think|reason/.test(key)) return brainIcon;
  if (/fast|speed/.test(key)) return boltIcon;
  if (/agent/.test(key)) return robotIcon;
  return adjustmentsIcon;
}

export function ConfigSelect({
  tab,
  option,
  onChange,
}: {
  tab: number;
  option: acp.SessionConfigOption & { type: "select" };
  onChange: (value: string) => void;
}) {
  const flat = option.options.flatMap((o) => ("options" in o ? o.options : [o]));
  return (
    <label className="config-item" title={option.description ? `${option.name}: ${option.description}` : option.name}>
      <span className="config-name" aria-label={option.name}>
        <Icon svg={configIcon(option)} />
      </span>
      <select
        value={option.currentValue}
        onChange={(e) => {
          onChange(e.target.value);
          post({ type: "setConfig", tab, configId: option.id, value: e.target.value });
        }}
      >
        {flat.map((o) => (
          <option key={o.value} value={o.value}>
            {o.name}
          </option>
        ))}
      </select>
    </label>
  );
}

export interface AgentChoices {
  agents: ReadonlyArray<{ id: string; name: string }>;
  activeId?: string;
}

const MANAGE_AGENTS = "\0manage";

/** Picks the tab's agent from the installed and custom ones; the last entry opens the agent manager. */
export function AgentSelect({ tab, choices }: { tab: TabInfo | undefined; choices: AgentChoices }) {
  const { t } = useL10n();
  const { agents, activeId } = choices;
  // A tab without a pick yet gets the default.
  const picked = tab?.agentId ?? activeId;
  const value = agents.find((a) => a.id === picked)?.id ?? "";
  return (
    <span id="agent" className="config-item" title={t("chat.switchAgent")}>
      <select
        value={value}
        onChange={(e) => {
          const id = e.target.value;
          if (id === MANAGE_AGENTS) post({ type: "manageAgents" });
          else if (id && tab) post({ type: "setAgent", tab: tab.id, id });
        }}
      >
        {value === "" && (
          <option value="" disabled>
            {t("chat.noAgentSelected")}
          </option>
        )}
        {agents.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
        <option value={MANAGE_AGENTS}>{t("chat.manageAgents")}</option>
      </select>
    </span>
  );
}

/** Picks the workspace folder the tab's session runs in; shown in multi-root workspaces only. */
export function FolderSelect({ tab, folders }: { tab: TabInfo | undefined; folders: ReadonlyArray<WorkspaceFolderInfo> }) {
  const { t } = useL10n();
  if (!tab || folders.length < 2) return null;
  // A session opened from the history may run in a folder that is not a workspace root.
  const other = folders.some((f) => f.path === tab.cwd) ? undefined : tab.cwd;
  return (
    <span id="folder" className="config-item" title={`${t("chat.switchFolder")}\n${tab.cwd}`}>
      <span className="config-name" aria-hidden="true">
        <Icon svg={folderIcon} />
      </span>
      <select value={tab.cwd} onChange={(e) => post({ type: "setCwd", tab: tab.id, cwd: e.target.value })}>
        {other !== undefined && (
          <option value={other} disabled>
            {other.split(/[\\/]/).filter(Boolean).pop() ?? other}
          </option>
        )}
        {folders.map((f) => (
          <option key={f.path} value={f.path}>
            {f.name}
          </option>
        ))}
      </select>
    </span>
  );
}

export interface Usage {
  used: number;
  size: number;
  cost?: acp.Cost | null;
}

/** `compactAt`: where the agent auto-compacts, when that is before the end of the window. */
export function UsageMeter({ usage, compactAt }: { usage: Usage | undefined; compactAt: number | undefined }) {
  const { t, lang } = useL10n();
  if (!usage) return <span id="usage" hidden />;
  const compact = new Intl.NumberFormat(lang, { notation: "compact", maximumFractionDigits: 1 });
  const exact = new Intl.NumberFormat(lang);
  const limit = compactAt !== undefined && compactAt < usage.size ? compactAt : usage.size;
  const ratio = limit > 0 ? Math.min(1, usage.used / limit) : 0;
  const percent = Math.round(ratio * 100);
  let title = t("chat.contextUsageTitle", exact.format(usage.used), exact.format(usage.size));
  if (limit < usage.size) {
    title += `\n${t("chat.autoCompactAt", exact.format(limit))}`;
  }
  if (usage.cost) {
    const cost = new Intl.NumberFormat(lang, { style: "currency", currency: usage.cost.currency });
    title += `\n${t("chat.sessionCost", cost.format(usage.cost.amount))}`;
  }
  return (
    <span id="usage" title={title} data-level={ratio >= 0.9 ? "high" : ratio >= 0.7 ? "medium" : "low"}>
      <span id="usage-meter">
        <span id="usage-fill" style={{ width: `${percent}%` }} />
      </span>
      <span id="usage-text">{t("chat.contextUsage", compact.format(usage.used), compact.format(limit), percent)}</span>
    </span>
  );
}
