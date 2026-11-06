import type * as acp from "@agentclientprotocol/sdk";
import type { ReactNode } from "react";
import type { Choice } from "../../sessionOptions";
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

/** The name of the option's current value. */
function currentName(option: SelectOption): string {
  const flat = option.options.flatMap((o) => ("options" in o ? o.options : [o]));
  return flat.find((o) => o.value === option.currentValue)?.name ?? option.currentValue;
}

/** The session's models and its current model and level of thinking, as a comparison starts from them. */
export function sessionChoices(options: ReadonlyArray<acp.SessionConfigOption>): {
  models?: ReadonlyArray<Choice>;
  model?: string;
  effort?: string;
} {
  const selects = options.filter((o): o is SelectOption => o.type === "select");
  const model = selects.find((o) => configKind(o) === "model");
  const effort = selects.find((o) => configKind(o) === "effort")?.currentValue;
  return {
    ...(model && {
      model: model.currentValue,
      models: model.options
        .flatMap((o) => ("options" in o ? o.options : [o]))
        .map((o) => ({ value: o.value, name: o.name })),
    }),
    // The agent's own "default" is what no pick means.
    ...(effort !== undefined && !/^(default|auto)$/i.test(effort) && { effort }),
  };
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
      ? [
          { heading: o.name },
          ...o.options.map((v) => ({ value: v.value, label: v.name, title: v.description ?? undefined })),
        ]
      : [{ value: o.value, label: o.name, title: o.description ?? undefined }],
  );
  return (
    <SubMenu
      id={`config:${option.id}`}
      className={`panel-row${grouped ? " grouped" : ""}`}
      title={option.description ?? undefined}
      trigger={
        <>
          <Icon svg={configIcon(option)} />
          <span className="menu-label">{option.name}</span>
          <span className="submenu-value">{currentName(option)}</span>
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

/** The session's model and effort as text, for the button beside the agent's; undefined when the agent has neither. */
export function quickConfig(options: ReadonlyArray<acp.SessionConfigOption>): ReactNode {
  const selects = options.filter((o): o is SelectOption => o.type === "select");
  const quick = (["model", "effort"] as const).flatMap((kind) => selects.find((o) => configKind(o) === kind) ?? []);
  if (quick.length === 0) return undefined;
  return quick.map((option) => (
    <span key={option.id} className="quick-config" title={option.description ?? option.name}>
      {currentName(option)}
    </span>
  ));
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
