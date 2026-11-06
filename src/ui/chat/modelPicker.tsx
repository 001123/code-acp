import type * as acp from "@agentclientprotocol/sdk";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { Icon } from "../icon";
import { useL10n } from "../l10n";
import boltIcon from "@tabler/icons/outline/bolt.svg";
import checkIcon from "@tabler/icons/outline/check.svg";
import chevronUpIcon from "@tabler/icons/outline/chevron-up.svg";
import updateIcon from "@tabler/icons/outline/cloud-download.svg";
import searchIcon from "@tabler/icons/outline/search.svg";
import settingsIcon from "@tabler/icons/outline/settings.svg";
import starIcon from "@tabler/icons/outline/star.svg";
import starFilledIcon from "@tabler/icons/filled/star.svg";
import type { AgentOptions } from "../../sessionOptions";
import type { AgentChoices } from "./agentPanel";
import { AgentIcon } from "./agentIcon";
import type { FavoriteModel } from "./modelFavorites";
import { ConfigLoading, configIcon, configKind, currentName, type SelectOption } from "./sessionConfig";

const isMac = typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");

/** The values of a fast mode select that turn it on and off; undefined when it has no such pair. */
function fastValues(option: SelectOption): { on: string; off: string } | undefined {
  const values = option.options.flatMap((o) => ("options" in o ? o.options : [o])).map((o) => o.value);
  const on = values.find((v) => /^(on|true|enabled?|fast)$/i.test(v));
  const off = values.find((v) => /^(off|false|disabled?|standard|normal)$/i.test(v));
  return on !== undefined && off !== undefined ? { on, off } : undefined;
}

type Row =
  | { heading: ReactNode; key: string }
  | { agent: string; value: string; name: string; description?: string; current: boolean; key: string };
type ModelRow = Exclude<Row, { heading: ReactNode }>;

/** A select of the footer: a button that opens its values above it. */
function FooterSelect({
  option,
  align,
  onPick,
}: {
  option: SelectOption;
  align: "left" | "right";
  onPick: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  useEffect(() => {
    if (open) root.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
  }, [open]);
  return (
    <div ref={root} className="picker-drop">
      <button
        type="button"
        className="picker-chip"
        title={option.description ?? option.name}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Icon svg={configIcon(option)} />
        <span className="label-text">{currentName(option)}</span>
        <Icon svg={chevronUpIcon} />
      </button>
      {open && (
        <div
          className={`popup-menu picker-drop-list ${align}`}
          role="menu"
          aria-label={option.name}
          onKeyDown={(e) => {
            const items = [...e.currentTarget.querySelectorAll<HTMLElement>("[role=menuitemradio]")];
            const at = items.indexOf(document.activeElement as HTMLElement);
            if (e.key === "Escape") {
              // The panel closes on Escape too: only this list should.
              e.nativeEvent.stopPropagation();
              setOpen(false);
              root.current?.querySelector<HTMLElement>(".picker-chip")?.focus();
            } else if (e.key === "ArrowDown") items[(at + 1) % items.length]?.focus();
            else if (e.key === "ArrowUp") items[(at - 1 + items.length) % items.length]?.focus();
            else return;
            e.preventDefault();
          }}
        >
          {option.options.map((o) =>
            "options" in o ? (
              <div key={o.group} className="menu-group">
                <div className="menu-heading" role="presentation">
                  {o.name}
                </div>
                {o.options.map((v) => (
                  <DropItem key={v.value} choice={v} current={option.currentValue} onPick={pick} />
                ))}
              </div>
            ) : (
              <DropItem key={o.value} choice={o} current={option.currentValue} onPick={pick} />
            ),
          )}
        </div>
      )}
    </div>
  );
  function pick(value: string) {
    setOpen(false);
    if (value !== option.currentValue) onPick(value);
  }
}

function DropItem({
  choice,
  current,
  onPick,
}: {
  choice: acp.SessionConfigSelectOption;
  current: string;
  onPick: (value: string) => void;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={choice.value === current}
      title={choice.description ?? undefined}
      onClick={() => onPick(choice.value)}
    >
      <span className="menu-label">{choice.name}</span>
      <span className="menu-check" aria-hidden="true">
        <Icon svg={checkIcon} />
      </span>
    </button>
  );
}

/** What another agent offers, read while its button in the rail is hovered. */
export interface AgentPreview {
  options?: AgentOptions;
  error?: string;
}

const FAVORITES = "\0favorites";

/**
 * The agent panel's body: a rail of agents (and the starred models) to the left, the models to pick from with a search
 * above them, the levels of thinking to the right, and the session's other options (fast mode, permissions…) below.
 * Hovering an agent of the rail shows its models; picking one switches the tab to that agent.
 */
export function ModelPicker({
  choices,
  agentId,
  config,
  loading,
  favorites,
  previews,
  focusSearch,
  onBrowse,
  onSetAgent,
  onSetConfig,
  onToggleFavorite,
  onPickOther,
  onManageAgents,
  onUpdateAgent,
}: {
  choices: AgentChoices;
  agentId: string | undefined;
  /** Undefined without a tab. */
  config: ReadonlyArray<acp.SessionConfigOption> | undefined;
  loading: boolean;
  favorites: ReadonlyArray<FavoriteModel>;
  previews: Readonly<Record<string, AgentPreview>>;
  focusSearch: boolean;
  /** Another agent is shown: load what it offers. */
  onBrowse: (id: string) => void;
  onSetAgent: (id: string) => void;
  onSetConfig: (configId: string, value: string) => void;
  onToggleFavorite: (favorite: FavoriteModel) => void;
  /** A model of another agent: switch to it, then pick the model. */
  onPickOther: (favorite: FavoriteModel) => void;
  onManageAgents: () => void;
  onUpdateAgent: (id: string) => void;
}) {
  const { t } = useL10n();
  /** The agent whose models are shown, or the starred models. */
  const [view, setView] = useState<string | undefined>(agentId);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(hoverTimer.current), []);
  useEffect(() => {
    if (focusSearch) search.current?.focus();
  }, [focusSearch]);
  // Switched: show the new agent's models.
  useEffect(() => setView((v) => (v === FAVORITES ? v : agentId)), [agentId]);

  const show = (id: string) => {
    clearTimeout(hoverTimer.current);
    setView(id);
    if (id !== FAVORITES && id !== agentId) onBrowse(id);
  };
  const showSoon = (id: string) => {
    clearTimeout(hoverTimer.current);
    // A beat, so the pointer can cross the rail without loading every agent on its way.
    hoverTimer.current = setTimeout(() => show(id), 120);
  };

  const favoritesShown = view === FAVORITES;
  const shownId = favoritesShown ? undefined : (view ?? agentId);
  const other = shownId !== undefined && shownId !== agentId ? choices.agents.find((a) => a.id === shownId) : undefined;
  const preview = other ? previews[other.id] : undefined;
  const current = choices.agents.find((a) => a.id === agentId);
  const selects = (loading ? [] : (config ?? [])).filter((o): o is SelectOption => o.type === "select");
  const model = selects.find((o) => configKind(o) === "model");
  const effort = selects.find((o) => configKind(o) === "effort");
  const fast = selects.find((o) => configKind(o) === "fast" && fastValues(o));
  const mode = selects.find((o) => configKind(o) === "mode");
  const others = selects.filter((o) => o !== model && o !== effort && o !== fast && o !== mode);

  const q = query.trim().toLowerCase();
  const matches = (...texts: ReadonlyArray<string | null | undefined>) =>
    !q || texts.some((s) => s?.toLowerCase().includes(q));
  const isFavorite = (agent: string, value: string) => favorites.some((f) => f.agent === agent && f.value === value);

  const rows: Row[] = [];
  if (favoritesShown) {
    for (const a of choices.agents) {
      const own = favorites.filter((f) => f.agent === a.id && matches(f.name, f.value, a.name));
      if (own.length === 0) continue;
      rows.push({
        key: `agent:${a.id}`,
        heading: (
          <>
            <AgentIcon icon={a.icon} />
            {a.name}
          </>
        ),
      });
      for (const f of own) {
        // The running agent's own name for it, which may have changed.
        const live =
          a.id === agentId && model
            ? model.options.flatMap((o) => ("options" in o ? o.options : [o])).find((o) => o.value === f.value)
            : undefined;
        rows.push({
          key: `${a.id}\0${f.value}`,
          agent: a.id,
          value: f.value,
          name: live?.name ?? f.name,
          current: a.id === agentId && model?.currentValue === f.value,
        });
      }
    }
  } else if (other) {
    for (const v of preview?.options?.models ?? [])
      if (matches(v.name, v.value, v.description))
        rows.push({
          key: `${other.id}\0${v.value}`,
          agent: other.id,
          value: v.value,
          name: v.name,
          ...(v.description ? { description: v.description } : {}),
          current: false,
        });
  } else if (model && agentId) {
    for (const o of model.options) {
      const group = "options" in o ? o.options : [o];
      const shown = group.filter((v) => matches(v.name, v.value, v.description));
      if (shown.length === 0) continue;
      if ("options" in o) rows.push({ key: `group:${o.group}`, heading: o.name });
      for (const v of shown)
        rows.push({
          key: `${agentId}\0${v.value}`,
          agent: agentId,
          value: v.value,
          name: v.name,
          ...(v.description ? { description: v.description } : {}),
          current: v.value === model.currentValue,
        });
    }
  }
  const pickable = rows.filter((r): r is ModelRow => "value" in r);
  const at = Math.min(active, Math.max(0, pickable.length - 1));

  useEffect(() => setActive(0), [query, view]);
  useEffect(() => {
    list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [at]);

  const pick = (row: ModelRow) => {
    if (row.agent !== agentId) onPickOther({ agent: row.agent, value: row.value, name: row.name });
    else if (model && row.value !== model.currentValue) onSetConfig(model.id, row.value);
  };

  const onKey = (e: ReactKeyboardEvent<HTMLElement>) => {
    const mod = isMac ? e.metaKey : e.ctrlKey;
    if (mod && /^[1-9]$/.test(e.key)) {
      const row = pickable[Number(e.key) - 1];
      if (row) {
        e.preventDefault();
        pick(row);
      }
      return;
    }
    if (e.target !== search.current) {
      // Typing anywhere in the panel searches.
      if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey && !(e.target instanceof HTMLInputElement))
        search.current?.focus();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = pickable.length;
      if (n) setActive((at + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
    } else if (e.key === "Enter" && pickable[at]) {
      e.preventDefault();
      pick(pickable[at]);
    } else if (e.key === "Escape" && query) {
      // Clears the search first; the next Escape closes the panel.
      e.nativeEvent.stopPropagation();
      setQuery("");
    }
  };

  const waiting = favoritesShown ? false : other ? !preview?.options && !preview?.error : loading;
  const empty = favoritesShown
    ? favorites.length === 0
      ? t("chat.noFavorites")
      : t("chat.noModelsMatch")
    : waiting || config === undefined
      ? undefined
      : other
        ? (preview?.error ?? (preview?.options?.models.length ? t("chat.noModelsMatch") : t("chat.noModelChoice")))
        : model
          ? t("chat.noModelsMatch")
          : t("chat.noModelChoice");

  // Another agent's levels are shown as they are, to pick once switched to it.
  const levels = other
    ? (preview?.options?.efforts ?? []).map((c) => ({ value: c.value, name: c.name, description: c.description }))
    : (effort?.options.flatMap((o) => ("options" in o ? o.options : [o])) ?? []);
  const footer = fast || mode || others.length > 0;
  let shortcut = 0;
  return (
    <div
      className={`picker-body${effort || levels.length ? " with-effort" : ""}${footer ? " with-footer" : ""}`}
      onKeyDown={onKey}
    >
      <nav className="picker-rail" onMouseLeave={() => clearTimeout(hoverTimer.current)}>
        <button
          type="button"
          className="rail-btn"
          title={t("chat.favoriteModels")}
          aria-label={t("chat.favoriteModels")}
          aria-pressed={favoritesShown}
          onMouseEnter={() => showSoon(FAVORITES)}
          onClick={() => show(FAVORITES)}
        >
          <Icon svg={starFilledIcon} />
        </button>
        <div className="rail-sep" role="separator" />
        <div className="rail-agents">
          {choices.agents.map((a) => (
            <button
              key={a.id}
              type="button"
              className="rail-btn"
              title={a.name}
              aria-label={a.name}
              aria-pressed={a.id === shownId}
              data-current={a.id === agentId ? "" : undefined}
              data-update={a.update ? "" : undefined}
              onMouseEnter={() => showSoon(a.id)}
              onClick={() => show(a.id)}
              onDoubleClick={() => a.id !== agentId && onSetAgent(a.id)}
            >
              <AgentIcon icon={a.icon} />
            </button>
          ))}
        </div>
        <button
          type="button"
          className="rail-btn"
          title={t("chat.manageAgents")}
          aria-label={t("chat.manageAgents")}
          onClick={onManageAgents}
        >
          <Icon svg={settingsIcon} />
        </button>
      </nav>
      <section className="picker-models">
        <div className="picker-search">
          <Icon svg={searchIcon} />
          <input
            ref={search}
            type="text"
            value={query}
            placeholder={t("chat.searchModels")}
            aria-label={t("chat.searchModels")}
            onChange={(e) => setQuery(e.target.value)}
          />
          {!favoritesShown && (other ?? current)?.update && (
            <button
              type="button"
              id="agent-update"
              title={t("chat.updateAgent", (other ?? current)!.update)}
              onClick={() => onUpdateAgent((other ?? current)!.id)}
            >
              <Icon svg={updateIcon} />
              <span className="label-text">{(other ?? current)!.update}</span>
            </button>
          )}
        </div>
        {other && (
          <div className="picker-other">
            <AgentIcon icon={other.icon} />
            <span className="label-text">{other.name}</span>
            <button type="button" className="picker-switch" onClick={() => onSetAgent(other.id)}>
              {t("chat.switchToAgent")}
            </button>
          </div>
        )}
        <div ref={list} className="picker-list" role="listbox" aria-label={model?.name ?? t("chat.favoriteModels")}>
          {waiting && <ConfigLoading />}
          {rows.map((row) => {
            if (!("value" in row))
              return (
                <div key={row.key} className="menu-heading" role="presentation">
                  {row.heading}
                </div>
              );
            const n = ++shortcut;
            const starred = isFavorite(row.agent, row.value);
            return (
              <div
                key={row.key}
                className="picker-model"
                role="option"
                aria-selected={row.current}
                data-active={pickable[at] === row}
                title={row.description}
                onMouseMove={() => setActive(pickable.indexOf(row))}
                onClick={() => pick(row)}
              >
                <span className="menu-label">{row.name}</span>
                {row.current && <Icon svg={checkIcon} />}
                <span className="spacer" />
                <button
                  type="button"
                  className="picker-star"
                  data-on={starred}
                  title={starred ? t("chat.removeFavorite") : t("chat.addFavorite")}
                  aria-label={starred ? t("chat.removeFavorite") : t("chat.addFavorite")}
                  aria-pressed={starred}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleFavorite({ agent: row.agent, value: row.value, name: row.name });
                  }}
                >
                  <Icon svg={starred ? starFilledIcon : starIcon} />
                </button>
                {n <= 9 && <kbd className="picker-key">{isMac ? `⌘${n}` : `Ctrl+${n}`}</kbd>}
              </div>
            );
          })}
          {pickable.length === 0 && empty && <div className="picker-empty">{empty}</div>}
        </div>
      </section>
      {(effort || levels.length > 0) && (
        <section className="picker-effort" data-dimmed={other ? "" : undefined}>
          <div className="picker-effort-head" title={effort?.description ?? undefined}>
            {other || !effort ? t("chat.thinkingLevel") : effort.name}
          </div>
          <div className="picker-effort-list" role="radiogroup" aria-label={effort?.name ?? t("chat.thinkingLevel")}>
            {levels.map((v) => (
              <button
                key={v.value}
                type="button"
                role="radio"
                disabled={!!other}
                aria-checked={!other && v.value === effort?.currentValue}
                title={v.description ?? undefined}
                onClick={() => effort && v.value !== effort.currentValue && onSetConfig(effort.id, v.value)}
              >
                <span className="menu-label">{v.name}</span>
                <Icon svg={checkIcon} />
              </button>
            ))}
          </div>
        </section>
      )}
      {footer && (
        <div className="picker-footer" data-dimmed={other ? "" : undefined}>
          {fast && <FastSwitch option={fast} onSet={(value) => onSetConfig(fast.id, value)} />}
          {others.map((o) => (
            <FooterSelect key={o.id} option={o} align="left" onPick={(value) => onSetConfig(o.id, value)} />
          ))}
          <span className="spacer" />
          {mode && <FooterSelect option={mode} align="right" onPick={(value) => onSetConfig(mode.id, value)} />}
        </div>
      )}
    </div>
  );
}

/** Standard or fast: a fast mode select as two segments. */
function FastSwitch({ option, onSet }: { option: SelectOption; onSet: (value: string) => void }) {
  const { t } = useL10n();
  const values = fastValues(option)!;
  const on = option.currentValue === values.on;
  return (
    <div className="picker-segments" role="radiogroup" aria-label={option.name} title={option.description ?? undefined}>
      <button type="button" role="radio" aria-checked={!on} onClick={() => on && onSet(values.off)}>
        {t("chat.standardSpeed")}
      </button>
      <button type="button" role="radio" aria-checked={on} onClick={() => !on && onSet(values.on)}>
        <Icon svg={boltIcon} />
        {t("chat.fastSpeed")}
      </button>
    </div>
  );
}
