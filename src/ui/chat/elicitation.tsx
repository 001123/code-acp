import type * as acp from "@agentclientprotocol/sdk";
import { memo, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { ElicitationAnswer, ElicitationValue } from "../../chat/protocol";
import { MarkdownView } from "../markdown";
import { useL10n } from "../l10n";
import { openFile, post } from "./post";
import type { ElicitationItem } from "./transcript";

interface Choice {
  value: string;
  title: string;
  description?: string;
}

interface FieldBase {
  key: string;
  title?: string;
  description?: string;
  required: boolean;
}

/** A field of the form the chat knows how to show; others are left out. */
type Field = FieldBase &
  (
    | { kind: "choice"; choices: Choice[]; multiple: boolean; minItems?: number; maxItems?: number }
    | { kind: "text"; format?: acp.StringFormat; minLength?: number; maxLength?: number; pattern?: string }
    | { kind: "number"; integer: boolean; minimum?: number; maximum?: number }
    | { kind: "boolean" }
  );

/** What a field holds while the user fills it in: numbers as typed, unparsed. */
type Draft = Record<string, string | string[] | boolean | undefined>;

const opt = <T,>(value: T | null | undefined): T | undefined => value ?? undefined;

function fieldsOf(schema: acp.ElicitationSchema): Field[] {
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties ?? {}).flatMap(([key, property]): Field[] => {
    // Every known property type has these; an unknown one is left out below.
    const { title, description } = property as { title?: string | null; description?: string | null };
    const base = { key, title: opt(title), description: opt(description), required: required.has(key) };
    switch (property.type) {
      case "string": {
        const p = property as acp.StringPropertySchema;
        const choices = p.oneOf?.map((o) => ({ value: o.const, title: o.title, description: opt(o.description) })) ?? p.enum?.map((value) => ({ value, title: value }));
        if (choices) return [{ ...base, kind: "choice", choices, multiple: false }];
        return [{ ...base, kind: "text", format: opt(p.format), minLength: opt(p.minLength), maxLength: opt(p.maxLength), pattern: opt(p.pattern) }];
      }
      case "number":
      case "integer": {
        const p = property as acp.NumberPropertySchema;
        return [{ ...base, kind: "number", integer: property.type === "integer", minimum: opt(p.minimum), maximum: opt(p.maximum) }];
      }
      case "boolean":
        return [{ ...base, kind: "boolean" }];
      case "array": {
        const p = property as acp.MultiSelectPropertySchema;
        const items = p.items as Partial<acp.TitledMultiSelectItems & acp.StringMultiSelectItems>;
        const choices =
          items.anyOf?.map((o) => ({ value: o.const, title: o.title, description: opt(o.description) })) ??
          items.enum?.map((value) => ({ value, title: value }));
        if (!choices) return [];
        return [{ ...base, kind: "choice", choices, multiple: true, minItems: opt(p.minItems), maxItems: opt(p.maxItems) }];
      }
      default:
        return [];
    }
  });
}

function defaults(schema: acp.ElicitationSchema): Draft {
  const draft: Draft = {};
  for (const [key, property] of Object.entries(schema.properties ?? {})) {
    const value = property.default;
    if (typeof value === "number") draft[key] = String(value);
    else if (typeof value === "string" || typeof value === "boolean" || Array.isArray(value)) draft[key] = value as Draft[string];
  }
  return draft;
}

/** The field's value as sent to the agent; undefined when it is left empty. */
function valueOf(field: Field, value: Draft[string]): ElicitationValue | undefined {
  switch (field.kind) {
    case "boolean":
      return value === true;
    case "number": {
      const n = typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
      return Number.isFinite(n) ? n : undefined;
    }
    case "choice":
      if (field.multiple) return Array.isArray(value) && value.length > 0 ? value : undefined;
      return typeof value === "string" ? value : undefined;
    case "text":
      if (typeof value !== "string" || value.trim() === "") return undefined;
      // datetime-local has no zone; the schema's date-time is RFC 3339.
      return field.format === "date-time" ? new Date(value).toISOString() : value;
  }
}

/** Whether the selection count of a multi-select is within its bounds. */
function countOk(field: Field, value: Draft[string]): boolean {
  if (field.kind !== "choice" || !field.multiple) return true;
  const n = Array.isArray(value) ? value.length : 0;
  return n >= (field.minItems ?? 0) && n <= (field.maxItems ?? Infinity);
}

/** What the user filled in so far, by request; kept while the tab is not shown. */
const drafts = new Map<number, Draft>();

/** Whether the user is typing somewhere a form taking focus would interrupt. */
function typingElsewhere(): boolean {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement) || el === document.body) return false;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value !== "";
  return el.isContentEditable && (el.textContent ?? "") !== "";
}

const isMac = navigator.userAgent.includes("Mac");

/** A form the agent asks the user to fill in: choices as cards, numbered for the keyboard, beside free text. */
export const ElicitationView = memo(function ElicitationView({ item }: { item: ElicitationItem }) {
  const { t } = useL10n();
  const [fields] = useState(() => fieldsOf(item.schema));
  const [draft, setDraft] = useState<Draft>(() => drafts.get(item.requestId) ?? defaults(item.schema));
  const form = useRef<HTMLFormElement>(null);
  const done = item.outcome !== undefined;

  useLayoutEffect(() => {
    if (!done && !typingElsewhere()) {
      form.current?.querySelector<HTMLElement>("button.elicitation-option, input, textarea")?.focus({ preventScroll: true });
    }
  }, []);

  const set = (key: string, value: Draft[string]) =>
    setDraft((d) => {
      const next = { ...d, [key]: value };
      drafts.set(item.requestId, next);
      return next;
    });

  const pick = (field: Field & { kind: "choice" }, value: string) => {
    const current = draft[field.key];
    if (field.multiple) {
      const list = Array.isArray(current) ? current : [];
      set(field.key, list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
    } else {
      // Picking the chosen option again clears it, e.g. to answer with free text only.
      set(field.key, current === value ? undefined : value);
    }
  };

  const complete = fields.every((f) => (!f.required || valueOf(f, draft[f.key]) !== undefined) && countOk(f, draft[f.key]));

  const answer = (response: ElicitationAnswer) => post({ type: "elicitation", id: item.requestId, response });

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (done || !complete || !form.current?.reportValidity()) return;
    const content: Record<string, ElicitationValue> = {};
    for (const f of fields) {
      const value = valueOf(f, draft[f.key]);
      if (value !== undefined) content[f.key] = value;
    }
    answer({ action: "accept", content });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLFormElement>) => {
    if (done || e.nativeEvent.isComposing) return;
    const target = e.target as HTMLElement;
    const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey || (target instanceof HTMLTextAreaElement && !e.shiftKey))) {
      e.preventDefault();
      submit();
    } else if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey && /^[1-9]$/.test(e.key)) {
      // A digit picks an option of the field the focus is in, else of the first one with options.
      const key = target.closest<HTMLElement>("[data-field]")?.dataset["field"];
      const field = fields.find((f) => f.key === key && f.kind === "choice") ?? fields.find((f) => f.kind === "choice");
      const choice = field?.kind === "choice" ? field.choices[Number(e.key) - 1] : undefined;
      if (field?.kind === "choice" && choice) {
        e.preventDefault();
        pick(field, choice.value);
        form.current?.querySelector<HTMLElement>(`[data-field="${CSS.escape(field.key)}"] [data-index="${Number(e.key) - 1}"]`)?.focus();
      }
    }
  };

  const outcome =
    item.outcome === "accept" ? "chat.elicitation.answered" : item.outcome === "decline" ? "chat.elicitation.declined" : "chat.elicitation.cancelled";

  return (
    <form ref={form} className={"elicitation" + (done ? " done" : "")} onSubmit={submit} onKeyDown={onKeyDown}>
      <div className="elicitation-title">{t("chat.question")}</div>
      {item.message && <MarkdownView className="md elicitation-message" text={item.message} onOpenFile={openFile} />}
      <fieldset disabled={done}>
        {fields.map((field) => (
          <FieldView key={field.key} field={field} value={draft[field.key]} onPick={pick} onChange={set} />
        ))}
      </fieldset>
      {done ? (
        <div className="elicitation-outcome">{t(outcome)}</div>
      ) : (
        <div className="elicitation-actions">
          <button type="submit" disabled={!complete}>
            {t("chat.elicitation.submit")}
          </button>
          <button type="button" className="secondary" onClick={() => answer({ action: "decline" })}>
            {t("chat.elicitation.decline")}
          </button>
          <span className="elicitation-hint">
            {fields.some((f) => f.kind === "choice")
              ? t("chat.elicitation.hint", "1–9", isMac ? "⌘Enter" : "Ctrl+Enter")
              : null}
          </span>
        </div>
      )}
    </form>
  );
});

function FieldView({
  field,
  value,
  onPick,
  onChange,
}: {
  field: Field;
  value: Draft[string];
  onPick: (field: Field & { kind: "choice" }, value: string) => void;
  onChange: (key: string, value: Draft[string]) => void;
}) {
  const { t } = useL10n();
  const label = field.title ?? (field.kind === "text" || field.kind === "number" ? undefined : field.description);
  const required = field.required && <span className="elicitation-required" title={t("chat.elicitation.required")}> *</span>;
  switch (field.kind) {
    case "choice": {
      const chosen = (v: string) => (field.multiple ? Array.isArray(value) && value.includes(v) : value === v);
      return (
        <div className="elicitation-field" data-field={field.key} role={field.multiple ? "group" : "radiogroup"} aria-label={label}>
          {label && (
            <div className="elicitation-label">
              {label}
              {required}
            </div>
          )}
          {field.title && field.description && <div className="elicitation-description">{field.description}</div>}
          <div className="elicitation-options">
            {field.choices.map((choice, i) => (
              <button
                key={choice.value}
                type="button"
                data-index={i}
                role={field.multiple ? "checkbox" : "radio"}
                aria-checked={chosen(choice.value)}
                className={"elicitation-option" + (chosen(choice.value) ? " chosen" : "") + (field.multiple ? " multiple" : "")}
                onClick={() => onPick(field, choice.value)}
              >
                <span className="elicitation-key">{i < 9 ? i + 1 : ""}</span>
                <span className="elicitation-option-text">
                  <span className="elicitation-option-title">{choice.title}</span>
                  {choice.description && <span className="elicitation-option-description">{choice.description}</span>}
                </span>
              </button>
            ))}
          </div>
        </div>
      );
    }
    case "boolean":
      return (
        <label className="elicitation-field elicitation-check" data-field={field.key}>
          <input type="checkbox" checked={value === true} onChange={(e) => onChange(field.key, e.target.checked)} />
          <span>
            {label ?? field.key}
            {required}
          </span>
        </label>
      );
    case "number":
    case "text": {
      const common = {
        className: "elicitation-input",
        value: typeof value === "string" ? value : "",
        required: field.required,
        placeholder: field.description,
        "aria-label": field.title ?? field.description ?? field.key,
      };
      const input =
        field.kind === "number" ? (
          <input
            {...common}
            type="number"
            step={field.integer ? 1 : "any"}
            min={field.minimum}
            max={field.maximum}
            onChange={(e) => onChange(field.key, e.target.value)}
          />
        ) : field.format ? (
          <input
            {...common}
            type={{ email: "email", uri: "url", date: "date", "date-time": "datetime-local" }[field.format]}
            minLength={field.minLength}
            maxLength={field.maxLength}
            pattern={field.pattern}
            onChange={(e) => onChange(field.key, e.target.value)}
          />
        ) : field.pattern ? (
          // Only an input checks a pattern.
          <input
            {...common}
            minLength={field.minLength}
            maxLength={field.maxLength}
            pattern={field.pattern}
            onChange={(e) => onChange(field.key, e.target.value)}
          />
        ) : (
          <textarea
            {...common}
            rows={1}
            minLength={field.minLength}
            maxLength={field.maxLength}
            onChange={(e) => onChange(field.key, e.target.value)}
          />
        );
      return (
        <div className="elicitation-field" data-field={field.key}>
          {field.title && (
            <div className="elicitation-label">
              {field.title}
              {required}
            </div>
          )}
          {input}
        </div>
      );
    }
  }
}
