import { useEffect, useState, type ReactNode } from "react";
import type { CatalogAgent, CatalogState } from "../../agentCatalog";
import type { ProviderChoice } from "../../agentManager";
import type { DoctorFix, DoctorResult, DoctorState } from "../../doctor";
import type { CustomAgentEntry, ProviderPrefs, SessionDefaults } from "../../settings";
import type { Choice } from "../../sessionOptions";
import { Icon } from "../icon";
import { useL10n, type MessageKey } from "../l10n";
import { isHidden, orderModels } from "../modelPrefs";
import { SessionOptionFields } from "./agentModel";
import { formatArgs, parseArgs } from "./args";
import { AgentCatalogTab } from "./catalog";
import { EntryList } from "./entries";
import { Field, Text, Toggle, UserOnly } from "./fields";
import { formatPairs, parsePairs } from "./pairs";
import { post, set } from "./post";
import { stringOf, type LoadedOptions, type State } from "./state";
import { SubTabs } from "./tabs";
import arrowDownIcon from "@tabler/icons/outline/arrow-down.svg";
import arrowUpIcon from "@tabler/icons/outline/arrow-up.svg";
import loaderIcon from "@tabler/icons/outline/loader-2.svg";
import plusIcon from "@tabler/icons/outline/plus.svg";
import refreshIcon from "@tabler/icons/outline/refresh.svg";
import robotIcon from "@tabler/icons/outline/robot.svg";
import settingsIcon from "@tabler/icons/outline/settings.svg";
import starIcon from "@tabler/icons/outline/star.svg";
import starFilledIcon from "@tabler/icons/filled/star.svg";
import trashIcon from "@tabler/icons/outline/trash.svg";
import updateIcon from "@tabler/icons/outline/arrow-up-circle.svg";
import xIcon from "@tabler/icons/outline/x.svg";

/** What the right side shows: a provider by id, the page to add one, or the settings every provider shares. */
export type ProviderView = string;
export const ADD_VIEW = "\0add";
export const SHARED_VIEW = "\0shared";

export type AddSection = "registry" | "custom";

const CUSTOM_PREFIX = "custom:";

const KIND_LABEL: Record<NonNullable<ProviderChoice["kind"]>, MessageKey> = {
  npx: "providers.kind.npx",
  uvx: "providers.kind.uvx",
  binary: "providers.kind.binary",
};

type Status = "ok" | "login" | "error" | "warning" | "checking";

const STATUS_LABEL: Record<Status, MessageKey> = {
  ok: "providers.status.ok",
  login: "providers.status.login",
  error: "providers.status.error",
  warning: "providers.status.warning",
  checking: "providers.status.checking",
};

const FIX_LABEL: Record<DoctorFix["type"], MessageKey> = {
  open: "doctor.fix.open",
  manageAgents: "doctor.fix.manageAgents",
  login: "doctor.fix.login",
  showLog: "doctor.fix.showLog",
};

/** What the last checks said of the provider `id`; undefined when it was not checked. */
function statusOf(doctor: DoctorState, id: string): { status: Status; result?: DoctorResult } | undefined {
  const row = doctor.rows.find((r) => r.id === `agent:${id}`);
  if (!row) return undefined;
  const result = row.result;
  if (!result) return doctor.running ? { status: "checking" } : undefined;
  if (result.status === "ok") return { status: "ok", result };
  if (result.fix?.type === "login") return { status: "login", result };
  return { status: result.status, result };
}

/** The codeAcp.providers entries the page shows. */
const prefsOf = (state: State) => (state.values.providers ?? {}) as Readonly<Record<string, ProviderPrefs>>;

/** Writes `patch` over the prefs of provider `id`; what is back to its default is dropped, and an entry left empty. */
function setPrefs(state: State, id: string, patch: Partial<ProviderPrefs>): void {
  const all = prefsOf(state);
  const merged: Record<string, unknown> = { ...all[id], ...patch };
  const kept = Object.fromEntries(
    Object.entries(merged).filter(
      ([key, v]) =>
        v !== undefined &&
        !(key === "enabled" && v === true) &&
        !(Array.isArray(v) && v.length === 0) &&
        !(key === "env" && Object.keys(v as object).length === 0),
    ),
  );
  const { [id]: _, ...others } = all;
  set("providers", Object.keys(kept).length ? { ...others, [id]: kept } : others);
}

/** "just now", "5m ago", "2h ago", "3d ago". */
function useAgo(at: number | undefined): string | undefined {
  const { t } = useL10n();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [at]);
  if (at === undefined) return undefined;
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return t("providers.justNow");
  if (minutes < 60) return t("providers.minutesAgo", minutes);
  if (minutes < 60 * 24) return t("providers.hoursAgo", Math.floor(minutes / 60));
  return t("providers.daysAgo", Math.floor(minutes / (60 * 24)));
}

function ProviderIcon({ icon }: { icon: string | undefined }) {
  return icon ? (
    <span className="provider-icon" style={{ maskImage: `url("${icon}")` }} />
  ) : (
    <span className="provider-icon-fallback">
      <Icon svg={robotIcon} />
    </span>
  );
}

/** The Providers tab: the agents on the left, what the one picked runs with on the right. */
export function ProvidersTab(props: {
  state: State;
  catalog: CatalogState;
  doctor: DoctorState;
  loaded: LoadedOptions;
  load: (agentId: string, model: string) => void;
  view: ProviderView;
  onView: (view: ProviderView) => void;
  addSection: AddSection;
  onAddSection: (section: AddSection) => void;
}) {
  const { t } = useL10n();
  const { state, catalog, doctor, view } = props;
  const providers = state.providers;
  // A provider gone (uninstalled, removed) leaves the first one, or the page to add one.
  const shown =
    view === ADD_VIEW || view === SHARED_VIEW || providers.some((p) => p.id === view)
      ? view
      : (providers[0]?.id ?? ADD_VIEW);
  const provider = providers.find((p) => p.id === shown);
  const checked = useAgo(catalog.checkedAt);
  const locked = state.locked.includes("providers");

  return (
    <div className="providers">
      <div className="providers-toolbar">
        <span className="providers-count">{t("providers.count", providers.length)}</span>
        <button
          className={"providers-checked" + (catalog.loading ? " loading" : "")}
          disabled={catalog.loading}
          title={t("providers.checkUpdates")}
          onClick={() => post({ type: "catalogRefresh" })}
        >
          <Icon svg={catalog.loading ? loaderIcon : refreshIcon} />
          {catalog.loading
            ? t("providers.checking")
            : checked
              ? t("providers.checked", checked)
              : t("providers.checkUpdates")}
        </button>
      </div>
      <div className="providers-split">
        <nav className="providers-list" aria-label={t("settings.providers")}>
          {providers.map((p) => (
            <ProviderRow
              key={p.id}
              provider={p}
              selected={p.id === shown}
              active={p.id === state.activeId}
              catalog={catalog.agents.find((a) => a.id === p.id)}
              status={statusOf(doctor, p.id)?.status}
              locked={locked}
              onSelect={() => props.onView(p.id)}
              onToggle={(enabled) => setPrefs(state, p.id, { enabled })}
            />
          ))}
          {!providers.length && <div className="providers-empty">{t("providers.empty")}</div>}
          <div className="providers-nav">
            <button
              className="provider-nav"
              aria-current={shown === ADD_VIEW ? "page" : undefined}
              onClick={() => props.onView(ADD_VIEW)}
            >
              <Icon svg={plusIcon} />
              {t("providers.add")}
            </button>
            <button
              className="provider-nav"
              aria-current={shown === SHARED_VIEW ? "page" : undefined}
              onClick={() => props.onView(SHARED_VIEW)}
            >
              <Icon svg={settingsIcon} />
              {t("providers.shared")}
            </button>
          </div>
        </nav>
        <section className="providers-detail">
          {provider ? (
            <ProviderDetail
              key={provider.id}
              provider={provider}
              state={state}
              catalog={catalog.agents.find((a) => a.id === provider.id)}
              status={statusOf(doctor, provider.id)}
              doctorRunning={doctor.running}
              loaded={props.loaded}
              load={props.load}
              locked={locked}
            />
          ) : shown === SHARED_VIEW ? (
            <SharedSettings state={state} />
          ) : (
            <AddProvider state={state} catalog={catalog} section={props.addSection} onSection={props.onAddSection} />
          )}
        </section>
      </div>
    </div>
  );
}

function ProviderRow(props: {
  provider: ProviderChoice;
  selected: boolean;
  active: boolean;
  catalog?: CatalogAgent;
  status?: Status;
  locked: boolean;
  onSelect: () => void;
  onToggle: (enabled: boolean) => void;
}) {
  const { t } = useL10n();
  const p = props.provider;
  const update = props.catalog?.installedVersion && props.catalog.version !== props.catalog.installedVersion;
  return (
    <div
      className="provider-row"
      aria-current={props.selected ? "page" : undefined}
      data-disabled={p.enabled ? undefined : ""}
    >
      <button className="provider-pick" onClick={props.onSelect}>
        <ProviderIcon icon={p.icon} />
        <span className="provider-text">
          <span className="provider-title">
            <span className="provider-name">{p.name}</span>
            {p.version && <span className="provider-version">v{p.version}</span>}
            {update && <span className="provider-update" title={t("providers.update", props.catalog!.version)} />}
          </span>
          <span className="provider-sub">
            {props.status && <span className={`provider-status ${props.status}`}>{t(STATUS_LABEL[props.status])}</span>}
            <span>{t(p.kind ? KIND_LABEL[p.kind] : "providers.kind.custom")}</span>
            {props.active && p.enabled && <span className="provider-default">{t("providers.default")}</span>}
          </span>
        </span>
      </button>
      <span title={t(p.enabled ? "providers.disable" : "providers.enable", p.name)}>
        <Toggle id={`provider-enabled-${p.id}`} checked={p.enabled} disabled={props.locked} onChange={props.onToggle} />
      </span>
    </div>
  );
}

/** A heading of the detail, with what it is about below it. */
function Section(props: { title: MessageKey; desc?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  const { t } = useL10n();
  return (
    <div className="provider-section">
      <div className="provider-section-head">
        <h3>{t(props.title)}</h3>
        {props.actions}
      </div>
      {props.desc && <div className="desc">{props.desc}</div>}
      {props.children}
    </div>
  );
}

function ProviderDetail(props: {
  provider: ProviderChoice;
  state: State;
  catalog?: CatalogAgent;
  status?: { status: Status; result?: DoctorResult };
  doctorRunning: boolean;
  loaded: LoadedOptions;
  load: (agentId: string, model: string) => void;
  locked: boolean;
}) {
  const { t } = useL10n();
  const { provider: p, state, catalog, status } = props;
  const prefs = prefsOf(state)[p.id] ?? {};
  const custom = p.id.startsWith(CUSTOM_PREFIX);
  const update =
    catalog?.installedVersion && catalog.version !== catalog.installedVersion ? catalog.version : undefined;
  const isDefault = p.id === state.activeId;
  const patch = (change: Partial<ProviderPrefs>) => setPrefs(state, p.id, change);

  // New sessions' model, effort and fast mode.
  const defaults = (state.values.sessionDefaults ?? {}) as Record<string, SessionDefaults>;
  const chosen = defaults[p.id];
  const choose = (change: SessionDefaults) => {
    const { [p.id]: _, ...others } = defaults;
    // What is back on the agent's default isn't kept, nor an agent left without any choice.
    const kept = Object.fromEntries(
      Object.entries({ ...chosen, ...change }).filter(([, value]) => value && value !== "default"),
    );
    set("sessionDefaults", Object.keys(kept).length ? { ...others, [p.id]: kept } : others);
  };

  const customName = p.id.slice(CUSTOM_PREFIX.length);
  const customEntries = (state.values.customAgents ?? {}) as Record<string, CustomAgentEntry>;
  const customLocked = state.locked.includes("customAgents");

  return (
    <div className="provider-detail">
      <div className="provider-head">
        <ProviderIcon icon={p.icon} />
        <div className="provider-head-text">
          <div className="provider-title">
            <span className="provider-head-name">{p.name}</span>
            {p.version && <span className="provider-version">v{p.version}</span>}
            {isDefault && p.enabled && <span className="provider-badge">{t("providers.default")}</span>}
            {!p.enabled && <span className="provider-badge muted">{t("providers.disabled")}</span>}
          </div>
          {catalog?.description && <div className="desc">{catalog.description}</div>}
        </div>
        <div className="provider-actions">
          {catalog?.busy ? (
            <span className="provider-busy">
              <Icon svg={loaderIcon} />
              {catalog.busy}
            </span>
          ) : (
            update && (
              <button className="with-icon" onClick={() => post({ type: "catalogInstall", id: p.id })}>
                <Icon svg={updateIcon} />
                {t("providers.update", update)}
              </button>
            )
          )}
          {!isDefault && p.enabled && (
            <button className="secondary" onClick={() => post({ type: "use", id: p.id })}>
              {t("providers.setDefault")}
            </button>
          )}
          <button
            className="icon-btn danger"
            disabled={custom && customLocked}
            title={t(custom ? "providers.remove" : "manager.uninstall")}
            aria-label={t(custom ? "providers.remove" : "manager.uninstall")}
            onClick={() => {
              if (!custom) return post({ type: "catalogUninstall", id: p.id });
              const { [customName]: _, ...rest } = customEntries;
              set("customAgents", rest);
            }}
          >
            <Icon svg={trashIcon} />
          </button>
        </div>
      </div>

      <div className={`provider-check ${status?.status ?? "none"}`}>
        <span className="provider-check-dot" aria-hidden />
        <span className="provider-check-text">
          {status ? t(STATUS_LABEL[status.status]) : t("providers.status.none")}
          {status?.result?.detail && status.status !== "ok" && <span className="desc"> · {status.result.detail}</span>}
        </span>
        {status?.result?.fix && status.status !== "ok" && (
          <button className="secondary" onClick={() => post({ type: "doctorFix", id: `agent:${p.id}` })}>
            {t(FIX_LABEL[status.result.fix.type])}
          </button>
        )}
        <button
          className="secondary with-icon"
          disabled={props.doctorRunning}
          onClick={() => post({ type: "doctorRun" })}
        >
          <Icon svg={refreshIcon} />
          {t(status ? "providers.checkAgain" : "providers.check")}
        </button>
      </div>

      <fieldset className="plain" disabled={props.locked}>
        {props.locked && <UserOnly />}
        <Section title="providers.launch">
          <div className="card">
            <Field
              id="provider-command"
              label="providers.command"
              desc={custom ? "providers.customCommandDesc" : "providers.commandDesc"}
              locked={custom && customLocked}
            >
              {custom ? (
                <Text
                  id="provider-command"
                  value={p.commandLine}
                  onCommit={(text) => {
                    const [command, ...args] = parseArgs(text);
                    if (!command) return;
                    const entry = customEntries[customName];
                    set("customAgents", { ...customEntries, [customName]: { ...entry, command, args } });
                  }}
                />
              ) : (
                <code className="provider-command">{p.commandLine}</code>
              )}
            </Field>
            <Field id="provider-args" label="providers.args" desc="providers.argsDesc">
              <Text
                id="provider-args"
                placeholder="--flag value"
                value={formatArgs(prefs.args ?? [])}
                onCommit={(text) => patch({ args: parseArgs(text) })}
              />
            </Field>
          </div>
        </Section>

        <Section title="providers.environment">
          <div className="card">
            <div className="field">
              <div className="provider-field-row">
                <div className="field-head">
                  <label>{t("providers.variables")}</label>
                  <div className="desc">{t("providers.variablesDesc")}</div>
                </div>
              </div>
              <Variables id={`provider-env-${p.id}`} value={prefs.env ?? {}} onChange={(env) => patch({ env })} />
            </div>
          </div>
          <div className="note muted">{t("providers.restartNote")}</div>
        </Section>
      </fieldset>

      <Section title="providers.newSessions" desc={t("providers.newSessionsDesc")}>
        <div className="card">
          <SessionOptionFields
            id="provider-default"
            agent={p.id}
            ready
            model={chosen?.model ?? ""}
            effort={chosen?.effort ?? ""}
            fastMode={chosen?.fastMode ?? "default"}
            onModel={(model) => choose({ model })}
            onEffort={(effort) => choose({ effort })}
            onFastMode={(fastMode) => choose({ fastMode })}
            clearableEffort
            modelDesc="settings.defaultModelDesc"
            effortDesc="settings.defaultEffortDesc"
            overridden={state.overridden.includes("sessionDefaults")}
            loaded={props.loaded}
            load={props.load}
          />
        </div>
      </Section>

      <fieldset className="plain" disabled={props.locked}>
        <Models provider={p} prefs={prefs} loaded={props.loaded} load={props.load} onChange={patch} />
      </fieldset>
    </div>
  );
}

/** Editable NAME / value rows, each committed on blur. */
function Variables(props: {
  id: string;
  value: Readonly<Record<string, string>>;
  onChange: (value: Record<string, string>) => void;
}) {
  const { t } = useL10n();
  const [adding, setAdding] = useState(false);
  const entries = Object.entries(props.value);
  const rename = (from: string, to: string) => {
    const name = to.trim();
    if (!name || (name !== from && name in props.value)) return;
    props.onChange(Object.fromEntries(entries.map(([k, v]) => (k === from ? [name, v] : [k, v]))));
  };
  return (
    <div className="variables">
      {entries.map(([name, value]) => (
        <div key={name} className="variable-row">
          <Text
            id={`${props.id}-name-${name}`}
            label={t("providers.varName")}
            value={name}
            onCommit={(next) => rename(name, next)}
          />
          <Text
            id={`${props.id}-value-${name}`}
            label={t("providers.varValue")}
            placeholder={t("providers.varValue")}
            value={value}
            onCommit={(next) => props.onChange({ ...props.value, [name]: next })}
          />
          <button
            className="icon-btn danger"
            title={t("providers.removeVariable")}
            aria-label={t("providers.removeVariable")}
            onClick={() => {
              const { [name]: _, ...rest } = props.value;
              props.onChange(rest);
            }}
          >
            <Icon svg={xIcon} />
          </button>
        </div>
      ))}
      {adding && (
        <div className="variable-row">
          <Text
            id={`${props.id}-new`}
            label={t("providers.varName")}
            placeholder="API_KEY"
            autoFocus
            value=""
            onCommit={(next) => {
              const name = next.trim();
              if (name && !(name in props.value)) props.onChange({ ...props.value, [name]: "" });
              setAdding(false);
            }}
          />
          <span />
          <button
            className="icon-btn"
            title={t("providers.removeVariable")}
            aria-label={t("providers.removeVariable")}
            onClick={() => setAdding(false)}
          >
            <Icon svg={xIcon} />
          </button>
        </div>
      )}
      <div className="variables-actions">
        <button className="secondary with-icon" onClick={() => setAdding(true)} disabled={adding}>
          <Icon svg={plusIcon} />
          {t("providers.addVariable")}
        </button>
      </div>
    </div>
  );
}

/** The agent's models: which the chat's picker shows, in what order, and which are starred. */
function Models(props: {
  provider: ProviderChoice;
  prefs: ProviderPrefs;
  loaded: LoadedOptions;
  load: (agentId: string, model: string) => void;
  onChange: (patch: Partial<ProviderPrefs>) => void;
}) {
  const { t } = useL10n();
  const { provider: p, prefs } = props;
  // Read by the New sessions fields above; any model's answer lists the same models.
  const asked = Object.values(props.loaded).filter((l) => l.agentId === p.id);
  const answered = asked.find((l) => l.options);
  const models = answered?.options?.models;
  const loading = !answered && asked.some((l) => l.error === undefined);
  const error = answered ? undefined : asked.find((l) => l.error)?.error;

  const ordered = orderModels(models ?? [], prefs);
  const shown = ordered.filter((m) => !isHidden(prefs, m.value));
  const hidden = ordered.filter((m) => isHidden(prefs, m.value));
  const favorites = prefs.favorites ?? [];
  const starred = (value: string) => favorites.some((f) => f.value === value);

  const move = (value: string, delta: number) => {
    const values = shown.map((m) => m.value);
    const i = values.indexOf(value);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= values.length) return;
    [values[i], values[j]] = [values[j]!, values[i]!];
    props.onChange({ modelOrder: [...values, ...hidden.map((m) => m.value)] });
  };
  const setHidden = (value: string, hide: boolean) => {
    const current = prefs.hiddenModels ?? [];
    props.onChange({ hiddenModels: hide ? [...current, value] : current.filter((v) => v !== value) });
  };
  const star = (m: Choice) =>
    props.onChange({
      favorites: starred(m.value)
        ? favorites.filter((f) => f.value !== m.value)
        : [...favorites, { value: m.value, name: m.name }],
    });

  const row = (m: Choice, i: number, visible: boolean) => (
    <div key={m.value} className="model-row" data-hidden={visible ? undefined : ""} title={m.description}>
      <button
        className="icon-btn model-star"
        data-on={starred(m.value)}
        title={t(starred(m.value) ? "chat.removeFavorite" : "chat.addFavorite")}
        aria-label={t(starred(m.value) ? "chat.removeFavorite" : "chat.addFavorite")}
        aria-pressed={starred(m.value)}
        onClick={() => star(m)}
      >
        <Icon svg={starred(m.value) ? starFilledIcon : starIcon} />
      </button>
      <span className="model-name">{m.name}</span>
      {m.name !== m.value && <code className="model-value">{m.value}</code>}
      <span className="spacer" />
      {visible && (
        <span className="model-move">
          <button
            className="icon-btn"
            disabled={i === 0}
            title={t("providers.moveUp")}
            aria-label={t("providers.moveUp")}
            onClick={() => move(m.value, -1)}
          >
            <Icon svg={arrowUpIcon} />
          </button>
          <button
            className="icon-btn"
            disabled={i === shown.length - 1}
            title={t("providers.moveDown")}
            aria-label={t("providers.moveDown")}
            onClick={() => move(m.value, 1)}
          >
            <Icon svg={arrowDownIcon} />
          </button>
        </span>
      )}
      <span title={t("providers.showInPicker", m.name)}>
        <Toggle id={`model-${p.id}-${m.value}`} checked={visible} onChange={(on) => setHidden(m.value, !on)} />
      </span>
    </div>
  );

  return (
    <Section
      title="providers.models"
      desc={t("providers.modelsDesc")}
      actions={
        <button
          className="icon-btn"
          disabled={loading}
          title={t("settings.reloadOptionsTitle")}
          aria-label={t("settings.reloadOptions")}
          onClick={() => props.load(p.id, "")}
        >
          <Icon svg={refreshIcon} />
        </button>
      }
    >
      {models && models.length > 0 && (
        <div className="models-toolbar">
          <button
            className="link-btn"
            onClick={() =>
              props.onChange({ hiddenModels: hidden.length === models.length ? [] : models.map((m) => m.value) })
            }
          >
            {t(hidden.length === models.length ? "providers.showAll" : "providers.hideAll")}
          </button>
          <span className="desc">{t("providers.modelCount", models.length, hidden.length)}</span>
        </div>
      )}
      {loading && <div className="note muted">{t("settings.loadingOptions")}</div>}
      {error && <div className="note error">{error}</div>}
      {models?.length === 0 && <div className="note muted">{t("settings.noModels")}</div>}
      {shown.length > 0 && <div className="models-list">{shown.map((m, i) => row(m, i, true))}</div>}
      {hidden.length > 0 && (
        <>
          <div className="models-heading">{t("providers.hiddenHeading")}</div>
          <div className="models-list">{hidden.map((m, i) => row(m, i, false))}</div>
        </>
      )}
    </Section>
  );
}

/** What every provider runs with. */
function SharedSettings({ state }: { state: State }) {
  const { t } = useL10n();
  const [envError, setEnvError] = useState<string>();
  const v = state.values;
  const overridden = (key: Parameters<typeof state.overridden.includes>[0]) => state.overridden.includes(key);
  const locked = (key: Parameters<typeof state.locked.includes>[0]) => state.locked.includes(key);
  return (
    <div className="provider-detail">
      <div className="provider-head">
        <span className="provider-icon-fallback">
          <Icon svg={settingsIcon} />
        </span>
        <div className="provider-head-text">
          <div className="provider-head-name">{t("providers.shared")}</div>
          <div className="desc">{t("providers.sharedDesc")}</div>
        </div>
      </div>
      <section className="card">
        <Field
          id="checkAgentUpdates"
          label="settings.checkUpdates"
          desc="settings.checkUpdatesDesc"
          overridden={overridden("checkAgentUpdates")}
          inline
        >
          <Toggle
            id="checkAgentUpdates"
            checked={v.checkAgentUpdates !== false}
            onChange={(checked) => set("checkAgentUpdates", checked)}
          />
        </Field>
        <Field
          id="nodePath"
          label="settings.nodePath"
          desc="settings.nodePathDesc"
          overridden={overridden("nodePath")}
          locked={locked("nodePath")}
        >
          <Text
            id="nodePath"
            placeholder="node"
            value={stringOf(state, "nodePath")}
            onCommit={(s) => set("nodePath", s.trim())}
          />
        </Field>
        <Field
          id="ccusagePath"
          label="settings.ccusagePath"
          desc="settings.ccusagePathDesc"
          overridden={overridden("ccusagePath")}
          locked={locked("ccusagePath")}
        >
          <Text
            id="ccusagePath"
            placeholder="ccusage"
            value={stringOf(state, "ccusagePath")}
            onCommit={(s) => set("ccusagePath", s.trim())}
          />
        </Field>
        <Field
          id="env"
          label="settings.env"
          desc="providers.sharedEnvDesc"
          overridden={overridden("env")}
          locked={locked("env")}
          error={envError}
        >
          <Text
            id="env"
            rows={4}
            placeholder="KEY=VALUE"
            value={formatPairs(v.env as Record<string, string> | undefined)}
            onReset={() => setEnvError(undefined)}
            onCommit={(text) => {
              const parsed = parsePairs(text);
              if (typeof parsed === "number") {
                setEnvError(t("settings.envInvalid", parsed));
                return;
              }
              setEnvError(undefined);
              set("env", parsed);
            }}
          />
        </Field>
      </section>
    </div>
  );
}

/** Installing an agent from the registry, or adding one that runs from a command. */
function AddProvider(props: {
  state: State;
  catalog: CatalogState;
  section: AddSection;
  onSection: (section: AddSection) => void;
}) {
  const { t } = useL10n();
  return (
    <div className="provider-detail">
      <div className="provider-head">
        <span className="provider-icon-fallback">
          <Icon svg={plusIcon} />
        </span>
        <div className="provider-head-text">
          <div className="provider-head-name">{t("providers.add")}</div>
          <div className="desc">{t("providers.addDesc")}</div>
        </div>
      </div>
      <SubTabs
        label={t("providers.add")}
        active={props.section}
        tabs={[
          { id: "registry", label: t("providers.registry") },
          { id: "custom", label: t("providers.customCommand") },
        ]}
        onSelect={props.onSection}
      />
      <div id="subpanel" role="tabpanel" aria-labelledby={`subtab-${props.section}`}>
        {props.section === "registry" ? (
          <AgentCatalogTab catalog={props.catalog} />
        ) : (
          <EntryList
            agents
            value={props.state.values.customAgents}
            overridden={props.state.overridden.includes("customAgents")}
            locked={props.state.locked.includes("customAgents")}
          />
        )}
      </div>
    </div>
  );
}
