import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { SettingsScope } from "../../settings";
import { Icon } from "../icon";
import { useL10n, type MessageKey } from "../l10n";
import warningIcon from "@tabler/icons/outline/alert-triangle.svg";

/** Which settings the page is on. */
export const ScopeContext = createContext<SettingsScope>("user");

/** That the setting has a workspace value: one that wins over the user's, or the one being edited. */
export function Overridden() {
  const { t } = useL10n();
  if (useContext(ScopeContext) === "workspace") {
    return <div className="note muted">{t("settings.setForWorkspace")}</div>;
  }
  return (
    <div className="note warning">
      <Icon svg={warningIcon} />
      {t("settings.overridden")}
    </div>
  );
}

/** That what is below can only be changed in the user's settings. */
export function UserOnly() {
  const { t } = useL10n();
  return <div className="note muted">{t("settings.userOnly")}</div>;
}

export function Field(props: {
  id: string;
  label: MessageKey;
  desc?: MessageKey;
  overridden?: boolean;
  /** Can't be changed on this page's scope. */
  locked?: boolean;
  error?: string;
  /** Puts the control beside the label instead of below it (switches). */
  inline?: boolean;
  children: ReactNode;
}) {
  const { t } = useL10n();
  return (
    <div className={props.inline ? "field inline" : "field"}>
      <div className="field-head">
        <label htmlFor={props.id}>{t(props.label)}</label>
        {props.desc && <div className="desc">{t(props.desc)}</div>}
      </div>
      <fieldset className="field-control" disabled={props.locked}>
        {props.children}
      </fieldset>
      {props.error && <div className="note error">{props.error}</div>}
      {props.locked ? <UserOnly /> : props.overridden && <Overridden />}
    </div>
  );
}

export function Toggle(props: {
  id: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <span className="toggle">
      <input
        id={props.id}
        type="checkbox"
        role="switch"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.checked)}
      />
      <span className="track" aria-hidden />
    </span>
  );
}

/**
 * A text input or textarea that commits on blur (and Enter for inputs), so typing is never
 * interrupted by a re-render. Outside values only replace the text while it is not focused.
 */
export function Text(props: {
  id: string;
  value: string;
  onCommit: (text: string) => void;
  /** Called when an outside value replaces the text. */
  onReset?: () => void;
  rows?: number;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState(props.value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) {
      setDraft(props.value);
      props.onReset?.();
    }
  }, [props.value]);

  const common = {
    id: props.id,
    value: draft,
    spellCheck: false,
    placeholder: props.placeholder,
    onFocus: () => (focused.current = true),
    onBlur: () => {
      focused.current = false;
      if (draft !== props.value) props.onCommit(draft);
    },
  };
  return props.rows ? (
    <textarea {...common} rows={props.rows} onChange={(e) => setDraft(e.target.value)} />
  ) : (
    <input
      {...common}
      type="text"
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && draft !== props.value) props.onCommit(draft);
      }}
    />
  );
}

/** Buttons of which one is picked, for a short list of choices. */
export function Segmented(props: {
  id: string;
  /** Added to the group's class, for a variant. */
  className?: string;
  /** Names the group when no label points at it. */
  label?: string;
  value: string | undefined;
  options: ReadonlyArray<{ value: string; label: string; title?: string }>;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <div
      id={props.id}
      className={props.className ? `segmented ${props.className}` : "segmented"}
      role="radiogroup"
      aria-label={props.label}
    >
      {props.options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === props.value}
          title={o.title}
          disabled={props.disabled}
          onClick={() => o.value !== props.value && props.onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
