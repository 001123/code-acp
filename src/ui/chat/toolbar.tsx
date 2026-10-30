import type * as acp from "@agentclientprotocol/sdk";
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import type { TabInfo, WorkspaceFolderInfo } from "../../chat/protocol";
import type { Totals } from "../../usageLedger";
import { Icon } from "../icon";
import { useL10n } from "../l10n";
import adjustmentsIcon from "@tabler/icons/outline/adjustments.svg";
import updateIcon from "@tabler/icons/outline/cloud-download.svg";
import boltIcon from "@tabler/icons/outline/bolt.svg";
import checkIcon from "@tabler/icons/outline/check.svg";
import chevronIcon from "@tabler/icons/outline/chevron-right.svg";
import brainIcon from "@tabler/icons/outline/brain.svg";
import cpuIcon from "@tabler/icons/outline/cpu.svg";
import folderIcon from "@tabler/icons/outline/folder.svg";
import robotIcon from "@tabler/icons/outline/robot.svg";
import settingsIcon from "@tabler/icons/outline/settings.svg";
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

/** An entry of a sub-menu: a pickable value, a group heading, or a separator. */
type SubMenuEntry =
  | { value: string; label: ReactNode; title?: string }
  | { heading: string }
  | "separator";

interface SubMenus {
  open: string | undefined;
  /** Opens a sub-menu (or closes them all), cancelling a pending change. */
  set: (id: string | undefined) => void;
  /** Does the same after `ms`, unless another change comes first. */
  later: (id: string | undefined, ms: number) => void;
}

/** Which sub-menu of a popup menu is open: only one at a time. */
const SubMenuContext = createContext<SubMenus>({ open: undefined, set: () => {}, later: () => {} });

/**
 * State for the sub-menus of a popup menu, closed with it. One timer for all rows, so leaving a row cannot close the
 * sub-menu of the row entered after it.
 */
function useSubMenus(menuOpen: boolean): SubMenus {
  const [open, setOpen] = useState<string>();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!menuOpen) {
      clearTimeout(timer.current);
      setOpen(undefined);
    }
  }, [menuOpen]);
  return {
    open,
    set: (id) => {
      clearTimeout(timer.current);
      setOpen(id);
    },
    later: (id, ms) => {
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setOpen(id), ms);
    },
  };
}

/** Where a sub-menu goes: beside the menu (right, else left), else over it; its top at its row, kept in the viewport. */
function placeSubMenu(row: DOMRect, menu: DOMRect, width: number, height: number): CSSProperties {
  const gap = 4;
  const margin = 4;
  const left =
    menu.right + gap + width <= window.innerWidth - margin
      ? menu.right + gap
      : menu.left - gap - width >= margin
        ? menu.left - gap - width
        : Math.max(margin, window.innerWidth - margin - width);
  const top = Math.max(margin, Math.min(row.top - 5, window.innerHeight - margin - height));
  return { left, top };
}

/**
 * A row of a popup menu that opens a list of values beside it on hover, click, Enter or ArrowRight. A pick closes it;
 * Escape or ArrowLeft goes back to the row.
 */
function SubMenu({
  id,
  className,
  title,
  trigger,
  entries,
  current,
  onPick,
}: {
  id: string;
  className: string;
  title?: string;
  trigger: ReactNode;
  entries: ReadonlyArray<SubMenuEntry>;
  current: string;
  onPick: (value: string) => void;
}) {
  const ctx = useContext(SubMenuContext);
  const open = ctx.open === id;
  const row = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden" });
  const focusOnOpen = useRef(false);
  useLayoutEffect(() => {
    if (!open) {
      setStyle({ visibility: "hidden" });
      return;
    }
    const menu = row.current?.closest(".popup-menu");
    const el = list.current;
    if (!row.current || !menu || !el) return;
    setStyle(placeSubMenu(row.current.getBoundingClientRect(), menu.getBoundingClientRect(), el.offsetWidth, el.offsetHeight));
    const selected = el.querySelector<HTMLElement>('[aria-checked="true"]');
    selected?.scrollIntoView({ block: "nearest" });
    if (focusOnOpen.current) {
      focusOnOpen.current = false;
      (selected ?? el.querySelector<HTMLElement>("[role=menuitemradio]"))?.focus();
    }
  }, [open]);
  const openNow = (focus: boolean) => {
    focusOnOpen.current = focus;
    ctx.set(id);
  };
  const close = () => {
    ctx.set(undefined);
    button.current?.focus();
  };
  const onListKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = [...(list.current?.querySelectorAll<HTMLElement>("[role=menuitemradio]") ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const move = (to: number) => items[(to + items.length) % items.length]?.focus();
    switch (e.key) {
      case "ArrowDown":
        move(at + 1);
        break;
      case "ArrowUp":
        move(at < 0 ? -1 : at - 1);
        break;
      case "Home":
        move(0);
        break;
      case "End":
        move(-1);
        break;
      case "Escape":
      case "ArrowLeft":
        close();
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };
  return (
    <div
      ref={row}
      className={`submenu-row ${className}`}
      onMouseEnter={() => {
        // Right away when no other sub-menu is open; after a beat otherwise, so the pointer can cross rows on its way.
        if (ctx.open === undefined || open) ctx.set(id);
        else ctx.later(id, 150);
      }}
      onMouseLeave={() => ctx.later(undefined, 250)}
    >
      <button
        ref={button}
        type="button"
        className="submenu-trigger"
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? ctx.set(undefined) : openNow(true))}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight") {
            e.preventDefault();
            openNow(true);
          }
        }}
      >
        {trigger}
        <span className="submenu-chevron" aria-hidden="true">
          <Icon svg={chevronIcon} />
        </span>
      </button>
      {open && (
        <div ref={list} className="popup-menu submenu" role="menu" style={style} onKeyDown={onListKey}>
          {entries.map((entry, i) =>
            entry === "separator" ? (
              <div key={`sep-${i}`} className="menu-separator" role="separator" />
            ) : "heading" in entry ? (
              <div key={`head-${i}`} className="menu-heading" role="presentation">
                {entry.heading}
              </div>
            ) : (
              <button
                key={entry.value}
                type="button"
                role="menuitemradio"
                aria-checked={entry.value === current}
                title={entry.title}
                onClick={() => {
                  onPick(entry.value);
                  close();
                }}
              >
                <span className="menu-label">{entry.label}</span>
                <span className="menu-check" aria-hidden="true">
                  <Icon svg={checkIcon} />
                </span>
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

/** One row of the agent panel: picks a value for a select config option. */
export function ConfigSelect({
  tab,
  option,
  onChange,
}: {
  tab: number;
  option: acp.SessionConfigOption & { type: "select" };
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

/** Open state of a menu that opens on hover or click and closes on Escape, a click outside, or a moment after the pointer leaves (so it can cross the gap between the button and the menu). */
function useHoverMenu() {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return {
    open,
    toggle: () => setOpen(!open),
    rootProps: {
      ref: root,
      onMouseEnter: () => {
        clearTimeout(closeTimer.current);
        setOpen(true);
      },
      onMouseLeave: () => {
        clearTimeout(closeTimer.current);
        closeTimer.current = setTimeout(() => setOpen(false), 200);
      },
    },
  };
}

export interface AgentChoices {
  /** `update`: the newer registry version the agent can be updated to. */
  agents: ReadonlyArray<{ id: string; name: string; icon?: string; update?: string }>;
  activeId?: string;
}

const MANAGE_AGENTS = "\0manage";

/** The agent's registry icon, tinted with the text color; the robot when it has none. */
function AgentIcon({ icon }: { icon: string | undefined }) {
  return icon ? <span className="agent-icon" style={{ maskImage: `url("${icon}")` }} /> : <Icon svg={robotIcon} />;
}

/**
 * The agent button: hover opens a panel that picks the tab's agent (the last entry opens the agent manager), installs
 * its update, and holds the session's config options (`children`).
 */
export function AgentPanel({ tab, choices, children }: { tab: TabInfo | undefined; choices: AgentChoices; children?: ReactNode }) {
  const { t } = useL10n();
  const menu = useHoverMenu();
  const subMenus = useSubMenus(menu.open);
  const { agents, activeId } = choices;
  // A tab without a pick yet gets the default.
  const picked = tab?.agentId ?? activeId;
  const current = agents.find((a) => a.id === picked);
  const value = current?.id ?? "";
  const label = current?.name ?? t("chat.noAgentSelected");
  return (
    <div id="agent" {...menu.rootProps}>
      <button
        type="button"
        className="icon-btn"
        title={label}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={menu.open}
        data-update={current?.update ? "" : undefined}
        onClick={menu.toggle}
      >
        <AgentIcon icon={current?.icon} />
      </button>
      {menu.open && (
        <div id="agent-panel" className="popup-menu" role="dialog" aria-label={t("chat.agentSettings")}>
          <SubMenuContext.Provider value={subMenus}>
            <div className="panel-head">
              <SubMenu
                id="agent"
                className="agent-switch"
                title={t("chat.switchAgent")}
                trigger={
                  <>
                    <AgentIcon icon={current?.icon} />
                    <span className="menu-label">{label}</span>
                  </>
                }
                entries={[
                  ...agents.map((a) => ({
                    value: a.id,
                    label: (
                      <>
                        <AgentIcon icon={a.icon} />
                        {a.name}
                        {a.update && <span className="submenu-value">↑ {a.update}</span>}
                      </>
                    ),
                  })),
                  "separator" as const,
                  { value: MANAGE_AGENTS, label: t("chat.manageAgents") },
                ]}
                current={value}
                onPick={(id) => {
                  if (id === MANAGE_AGENTS) post({ type: "manageAgents" });
                  else if (id !== value && tab) post({ type: "setAgent", tab: tab.id, id });
                }}
              />
              {current?.update && (
                <button
                  type="button"
                  id="agent-update"
                  title={t("chat.updateAgent", current.update)}
                  onClick={() => post({ type: "updateAgent", id: current.id })}
                >
                  <Icon svg={updateIcon} />
                  <span className="label-text">{current.update}</span>
                </button>
              )}
            </div>
            {children}
          </SubMenuContext.Provider>
        </div>
      )}
    </div>
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

/** The gear beside the send button: a menu of chat view toggles (follow the agent, auto-scroll). */
export function ChatSettings({ followAgent, autoScroll }: { followAgent: boolean; autoScroll: boolean }) {
  const { t } = useL10n();
  const menu = useHoverMenu();
  const rows = [
    { id: "follow", label: t("settings.followAgent"), title: t("chat.followAgent"), on: followAgent, type: "setFollowAgent" },
    { id: "auto-scroll", label: t("settings.autoScroll"), title: t("chat.autoScroll"), on: autoScroll, type: "setAutoScroll" },
  ] as const;
  return (
    <div id="chat-settings" {...menu.rootProps}>
      <button
        type="button"
        className="icon-btn"
        title={t("chat.viewSettings")}
        aria-label={t("chat.viewSettings")}
        aria-haspopup="menu"
        aria-expanded={menu.open}
        onClick={menu.toggle}
      >
        <Icon svg={settingsIcon} />
      </button>
      {menu.open && (
        <div id="chat-settings-menu" className="popup-menu" role="menu">
          {rows.map((r) => (
            <button
              key={r.id}
              type="button"
              id={r.id}
              role="menuitemcheckbox"
              aria-checked={r.on}
              title={r.title}
              onClick={() => post({ type: r.type, enabled: !r.on })}
            >
              <span className="menu-label">{r.label}</span>
              <span className="switch" aria-hidden="true" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export interface Usage {
  used: number;
  size: number;
  cost?: acp.Cost | null;
}

/** `compactAt`: where the agent auto-compacts, when that is before the end of the window. */
export function UsageMeter({
  usage,
  compactAt,
  totals,
}: {
  usage: Usage | undefined;
  compactAt: number | undefined;
  totals: Totals | undefined;
}) {
  const { t, lang } = useL10n();
  if (!usage) return <span id="usage" hidden />;
  const compact = new Intl.NumberFormat(lang, { notation: "compact", maximumFractionDigits: 1 });
  const exact = new Intl.NumberFormat(lang);
  const tokens = (n: number) => t("chat.tokens", exact.format(n));
  const limit = compactAt !== undefined && compactAt < usage.size ? compactAt : usage.size;
  const ratio = limit > 0 ? Math.min(1, usage.used / limit) : 0;
  const percent = Math.round(ratio * 100);
  const summary = t("chat.contextUsage", compact.format(usage.used), compact.format(limit), percent);
  const rows: Array<[string, string]> = [
    [t("chat.contextUsed"), tokens(usage.used)],
    [t("chat.contextLeft"), tokens(Math.max(0, limit - usage.used))],
    [t("chat.contextSize"), tokens(usage.size)],
  ];
  if (limit < usage.size) rows.push([t("chat.autoCompactAt"), tokens(limit)]);
  if (usage.cost) {
    const cost = new Intl.NumberFormat(lang, { style: "currency", currency: usage.cost.currency });
    rows.push([t("chat.sessionCost"), cost.format(usage.cost.amount)]);
  }
  if (totals?.tokens.total) rows.push([t("chat.sessionTokens"), tokens(totals.tokens.total)]);
  if (totals?.turns) rows.push([t("chat.sessionTurns"), exact.format(totals.turns)]);
  // A ring of radius 7 in a 16×16 box; the dash covers `ratio` of the circumference.
  const circumference = 2 * Math.PI * 7;
  return (
    // Focusable so the panel also opens from the keyboard.
    <span
      id="usage"
      tabIndex={0}
      role="button"
      aria-label={summary}
      onClick={() => post({ type: "showUsage" })}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") post({ type: "showUsage" });
      }}
      data-level={ratio >= 0.9 ? "high" : ratio >= 0.7 ? "medium" : "low"}>
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <circle className="usage-track" cx="8" cy="8" r="7" />
        <circle className="usage-fill" cx="8" cy="8" r="7" strokeDasharray={`${ratio * circumference} ${circumference}`} />
      </svg>
      <span id="usage-panel" role="tooltip">
        <span className="usage-head">
          <span>{t("chat.contextWindow")}</span>
          <span>{summary}</span>
        </span>
        <span className="usage-bar">
          <span style={{ width: `${percent}%` }} />
        </span>
        {rows.map(([label, value]) => (
          <span key={label} className="usage-row">
            <span>{label}</span>
            <span>{value}</span>
          </span>
        ))}
        <span className="usage-hint">{t("chat.showUsage")}</span>
      </span>
    </span>
  );
}
