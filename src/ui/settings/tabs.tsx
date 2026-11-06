import { useEffect, useRef, useState, type ReactNode } from "react";
import type { SettingKey } from "../../settings";
import { Icon } from "../icon";
import { useL10n, type MessageKey } from "../l10n";
import settingsIcon from "@tabler/icons/outline/settings.svg";
import languageIcon from "@tabler/icons/outline/language.svg";
import bellIcon from "@tabler/icons/outline/bell.svg";
import shieldIcon from "@tabler/icons/outline/shield-check.svg";
import branchIcon from "@tabler/icons/outline/git-branch.svg";
import stackIcon from "@tabler/icons/outline/stack-2.svg";
import plugIcon from "@tabler/icons/outline/plug-connected.svg";
import chartIcon from "@tabler/icons/outline/chart-bar.svg";
import bugIcon from "@tabler/icons/outline/bug.svg";

export type Tab =
  "general" | "language" | "notifications" | "permissions" | "git" | "providers" | "mcp" | "usage" | "debug";

export const TABS: ReadonlyArray<{ id: Tab; label: MessageKey; desc: MessageKey; icon: string; keys: SettingKey[] }> = [
  {
    id: "general",
    label: "settings.general",
    desc: "settings.generalDesc",
    icon: settingsIcon,
    keys: ["followAgent", "autoScroll", "showChanges", "showRestore", "rememberSessionOptions"],
  },
  {
    id: "language",
    label: "settings.language",
    desc: "settings.languageTabDesc",
    icon: languageIcon,
    keys: ["language"],
  },
  {
    id: "notifications",
    label: "settings.notificationsTab",
    desc: "settings.notificationsTabDesc",
    icon: bellIcon,
    keys: ["notifications", "notifyFinished"],
  },
  {
    id: "permissions",
    label: "settings.permissions",
    desc: "settings.permissionsDesc",
    icon: shieldIcon,
    keys: ["autoApprove", "allowedHttpHosts"],
  },
  {
    id: "git",
    label: "settings.git",
    desc: "settings.gitDesc",
    icon: branchIcon,
    keys: [
      "worktreeForNewTabs",
      "worktreeCopyFiles",
      "worktreeSetupCommand",
      "worktreeProjectSetupCommand",
      "commitMessage.agent",
      "commitMessage.model",
      "commitMessage.effort",
      "commitMessage.fastMode",
      "commitMessage.instructions",
    ],
  },
  {
    id: "providers",
    label: "settings.providers",
    desc: "settings.providersDesc",
    icon: stackIcon,
    keys: ["providers", "sessionDefaults", "checkAgentUpdates", "nodePath", "ccusagePath", "env", "customAgents"],
  },
  { id: "mcp", label: "settings.mcp", desc: "settings.mcpDesc", icon: plugIcon, keys: ["mcpServers"] },
  { id: "usage", label: "settings.usage", desc: "settings.usageDesc", icon: chartIcon, keys: [] },
  { id: "debug", label: "settings.debug", desc: "settings.debugDesc", icon: bugIcon, keys: ["tracing"] },
];

/** Tabs inside a section's panel, for what would be too much on one page. */
export function SubTabs<T extends string>(props: {
  label: string;
  active: T;
  tabs: ReadonlyArray<{ id: T; label: string; badge?: ReactNode }>;
  onSelect: (id: T) => void;
}) {
  const refs = useRef<Partial<Record<T, HTMLButtonElement | null>>>({});
  const move = (delta: number) => {
    const i = props.tabs.findIndex((tab) => tab.id === props.active);
    const next = props.tabs[(i + delta + props.tabs.length) % props.tabs.length].id;
    props.onSelect(next);
    refs.current[next]?.focus();
  };
  return (
    <div
      className="subtabs"
      role="tablist"
      aria-label={props.label}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") move(1);
        else if (e.key === "ArrowLeft") move(-1);
        else return;
        e.preventDefault();
      }}
    >
      {props.tabs.map((tab) => (
        <button
          key={tab.id}
          ref={(el) => {
            refs.current[tab.id] = el;
          }}
          id={`subtab-${tab.id}`}
          role="tab"
          className="subtab"
          aria-selected={props.active === tab.id}
          aria-controls="subpanel"
          tabIndex={props.active === tab.id ? 0 : -1}
          onClick={() => props.onSelect(tab.id)}
        >
          {tab.label}
          {tab.badge}
        </button>
      ))}
    </div>
  );
}

export function Tabs(props: { active: Tab; onSelect: (tab: Tab) => void; badge: (tab: Tab) => ReactNode }) {
  const { t } = useL10n();
  const refs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});
  const strip = useRef<HTMLElement>(null);
  const [more, setMore] = useState({ left: false, right: false });

  // Which sides have tabs scrolled out of view, while the strip is horizontal (narrow views).
  useEffect(() => {
    const el = strip.current;
    if (!el) return;
    const measure = () => {
      const left = el.scrollLeft > 1;
      const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
      setMore((m) => (m.left === left && m.right === right ? m : { left, right }));
    };
    // A vertical wheel (most mice) scrolls the strip sideways.
    const wheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
      e.preventDefault();
      el.scrollBy({ left: e.deltaY });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    el.addEventListener("scroll", measure, { passive: true });
    el.addEventListener("wheel", wheel, { passive: false });
    measure();
    return () => {
      observer.disconnect();
      el.removeEventListener("scroll", measure);
      el.removeEventListener("wheel", wheel);
    };
  }, []);

  // The selected tab is scrolled into view.
  useEffect(() => {
    refs.current[props.active]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [props.active]);
  const move = (delta: number) => {
    const i = TABS.findIndex((tab) => tab.id === props.active);
    const next = TABS[(i + delta + TABS.length) % TABS.length].id;
    props.onSelect(next);
    refs.current[next]?.focus();
  };
  return (
    <nav
      ref={strip}
      className={`tabs${more.left ? " more-left" : ""}${more.right ? " more-right" : ""}`}
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
