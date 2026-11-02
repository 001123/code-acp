import type * as acp from "@agentclientprotocol/sdk";
import { Icon } from "../icon";
import { useL10n } from "../l10n";
import adjustmentsIcon from "@tabler/icons/outline/adjustments.svg";
import boltIcon from "@tabler/icons/outline/bolt.svg";
import brainIcon from "@tabler/icons/outline/brain.svg";
import cpuIcon from "@tabler/icons/outline/cpu.svg";
import loaderIcon from "@tabler/icons/outline/loader-2.svg";
import robotIcon from "@tabler/icons/outline/robot.svg";
import shieldIcon from "@tabler/icons/outline/shield-half.svg";
import { SubMenu, type SubMenuEntry } from "./popupMenu";
import { post } from "./post";

type SelectOption = acp.SessionConfigOption & { type: "select" };

const CONFIG_ICONS = { mode: shieldIcon, model: cpuIcon, effort: brainIcon, fast: boltIcon, agent: robotIcon };

/** What a config option sets: by its ACP category, else by keywords in its id or name. */
function configKind(option: acp.SessionConfigOption): keyof typeof CONFIG_ICONS | undefined {
  switch (option.category) {
    case "mode":
      return "mode";
    case "model":
      return "model";
    case "thought_level":
      return "effort";
  }
  const key = `${option.id} ${option.name}`.toLowerCase();
  // Before "mode", which "model" contains.
  if (/model/.test(key)) return "model";
  if (/mode|permission/.test(key) && !/fast/.test(key)) return "mode";
  if (/effort|think|reason/.test(key)) return "effort";
  if (/fast|speed/.test(key)) return "fast";
  if (/agent/.test(key)) return "agent";
  return undefined;
}

function configIcon(option: acp.SessionConfigOption): string {
  const kind = configKind(option);
  return kind ? CONFIG_ICONS[kind] : adjustmentsIcon;
}

/** One row of the agent panel: picks a value for a select config option. */
export function ConfigSelect({
  tab,
  option,
  onChange,
}: {
  tab: number;
  option: SelectOption;
  onChange: (value: string) => void;
}) {
  const grouped = option.options.some((o) => "options" in o);
  const entries = option.options.flatMap((o): SubMenuEntry[] =>
    "options" in o
      ? [{ heading: o.name }, ...o.options.map((v) => ({ value: v.value, label: v.name, title: v.description ?? undefined }))]
      : [{ value: o.value, label: o.name, title: o.description ?? undefined }],
  );
  const flat = option.options.flatMap((o) => ("options" in o ? o.options : [o]));
  const currentName = flat.find((o) => o.value === option.currentValue)?.name ?? option.currentValue;
  return (
    <SubMenu
      id={`config:${option.id}`}
      className={`panel-row${grouped ? " grouped" : ""}`}
      title={option.description ?? undefined}
      trigger={
        <>
          <Icon svg={configIcon(option)} />
          <span className="menu-label">{option.name}</span>
          <span className="submenu-value">{currentName}</span>
        </>
      }
      entries={entries}
      current={option.currentValue}
      onPick={(value) => {
        if (value === option.currentValue) return;
        onChange(value);
        post({ type: "setConfig", tab, configId: option.id, value });
      }}
    />
  );
}

/** Beside the agent button: the session's model and effort, each a dropdown. */
export function QuickConfig({
  tab,
  options,
  onChange,
}: {
  tab: number;
  options: ReadonlyArray<acp.SessionConfigOption>;
  onChange: (configId: string, value: string) => void;
}) {
  const selects = options.filter((o): o is SelectOption => o.type === "select");
  const quick = (["model", "effort"] as const).flatMap((kind) => selects.find((o) => configKind(o) === kind) ?? []);
  return quick.map((option) => {
    const known = option.options.flatMap((o) => ("options" in o ? o.options : [o])).some((o) => o.value === option.currentValue);
    return (
      <span key={option.id} className="config-item quick-config" title={option.description ?? option.name}>
        <span className="config-name" aria-hidden="true">
          <Icon svg={configIcon(option)} />
        </span>
        <select
          aria-label={option.name}
          value={option.currentValue}
          onChange={(e) => {
            onChange(option.id, e.target.value);
            post({ type: "setConfig", tab, configId: option.id, value: e.target.value });
          }}
        >
          {!known && (
            <option value={option.currentValue} disabled>
              {option.currentValue}
            </option>
          )}
          {option.options.map((o) =>
            "options" in o ? (
              <optgroup key={o.group} label={o.name}>
                {o.options.map((v) => (
                  <option key={v.value} value={v.value}>
                    {v.name}
                  </option>
                ))}
              </optgroup>
            ) : (
              <option key={o.value} value={o.value}>
                {o.name}
              </option>
            ),
          )}
        </select>
      </span>
    );
  });
}

/** Stands in for the config options while the tab's new session starts. */
export function ConfigLoading() {
  const { t } = useL10n();
  return (
    <div className="config-loading" role="status">
      <Icon svg={loaderIcon} />
      <span className="menu-label">{t("chat.loadingOptions")}</span>
    </div>
  );
}
