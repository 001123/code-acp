import type { Editor } from "@tiptap/react";
import { useLayoutEffect, useRef, useState } from "react";
import type { Attachment } from "../../chat/protocol";
import type { FileSuggestion, SkillSuggestion } from "../../completions";
import type { ProblemSuggestion } from "../../problems";
import type { TerminalSuggestion } from "../../terminalContext";
import { flatText, offsetAt, replaceText } from "./editor";
import { post } from "./post";
import { byName, triggerIn, type Suggestion, type Trigger } from "./suggestions";
import type { TabState } from "./tabs";

/** The "@", "$" and "/" popup of the composer: what is being typed, what it offers, and its keys. */
export function useSuggestions({
  editor,
  active,
  commands,
  addAttachment,
}: {
  editor: Editor;
  active: number | undefined;
  commands: TabState["commands"];
  addAttachment: (a: Attachment, at?: Trigger) => void;
}) {
  const [trigger, setTrigger] = useState<Trigger>();
  const [selected, setSelected] = useState(0);
  const [files, setFiles] = useState<FileSuggestion[]>([]);
  const [terminals, setTerminals] = useState<TerminalSuggestion[]>([]);
  const [problems, setProblems] = useState<ProblemSuggestion[]>([]);
  const [skills, setSkills] = useState<SkillSuggestion[]>([]);
  /** Id of the latest file search; older answers are dropped. */
  const searchId = useRef(0);
  /** Start of the trigger closed with Escape; it stays closed until the caret leaves it. */
  const dismissed = useRef<number>(undefined);

  const close = () => setTrigger(undefined);

  // The popup belongs to the text of the tab that was shown.
  useLayoutEffect(close, [active]);

  /** Opens, updates or closes the popup for the text before the caret. */
  function refresh(): void {
    const { doc, selection } = editor.state;
    let next = selection.empty ? triggerIn(flatText(doc), offsetAt(doc, selection.from)) : undefined;
    if (next?.start !== dismissed.current) dismissed.current = undefined;
    if (dismissed.current !== undefined) next = undefined;
    if (next?.sigil === trigger?.sigil && next?.query === trigger?.query && next?.start === trigger?.start) {
      if (next && next.end !== trigger?.end) setTrigger(next);
      return;
    }
    setTrigger(next);
    setSelected(0);
    if (next?.sigil === "@") {
      // Results of an earlier "@" don't belong to this one.
      if (trigger?.sigil !== "@" || trigger.start !== next.start) {
        setFiles([]);
        setTerminals([]);
        setProblems([]);
      }
      post({ type: "searchFiles", id: ++searchId.current, query: next.query });
    }
    if (next?.sigil === "$" && trigger?.sigil !== "$") post({ type: "listSkills" });
  }

  /** Replaces the typed trigger with `text`. */
  function replaceTrigger(at: Trigger, text: string): void {
    replaceText(editor.view, at.start, at.end, text);
  }

  const suggestions: Suggestion[] = !trigger
    ? []
    : trigger.sigil === "/"
      ? byName(commands, (c) => c.name, trigger.query).map((c) => ({
          key: c.name,
          label: `/${c.name}`,
          detail: c.description,
          pick: () => replaceTrigger(trigger, `/${c.name} `),
        }))
      : trigger.sigil === "$"
        ? byName(skills, (s) => s.name, trigger.query).map((s) => ({
            key: s.uri,
            label: `$${s.name}`,
            detail: s.description,
            pick: () => addAttachment({ kind: "uri", uri: s.uri, name: s.name }, trigger),
          }))
        : [
            ...problems.map((p) => ({
              key: `problems:${p.scope}`,
              label: p.label,
              detail: p.detail,
              // Read when picked, so the list is current; it comes back as "addAttachments".
              pick: () => {
                replaceTrigger(trigger, "");
                post({ type: "attachProblems", scope: p.scope });
              },
            })),
            ...terminals.map((c) => ({
              key: `terminal:${c.id}`,
              label: c.label,
              detail: c.detail,
              // The output stays in the extension until picked; it comes back as "addAttachments".
              pick: () => {
                replaceTrigger(trigger, "");
                post({ type: "attachTerminal", id: c.id });
              },
            })),
            ...files.map((f) => ({
              key: f.uri,
              label: f.folder ? `${f.name}/` : f.name,
              detail: f.path,
              pick: () => addAttachment({ kind: "uri", uri: f.uri, name: f.name }, trigger),
            })),
          ];
  const shown = Math.min(selected, suggestions.length - 1);

  function pick(s: Suggestion): void {
    setTrigger(undefined);
    s.pick();
    editor.view.focus();
  }

  /** Popup keys; true when the key was used. */
  function onKey(e: KeyboardEvent): boolean {
    if (!trigger || suggestions.length === 0 || e.isComposing) return false;
    switch (e.key) {
      case "ArrowDown":
        setSelected((shown + 1) % suggestions.length);
        return true;
      case "ArrowUp":
        setSelected((shown - 1 + suggestions.length) % suggestions.length);
        return true;
      case "Enter":
      case "Tab":
        if (e.shiftKey) return false;
        pick(suggestions[shown]!);
        return true;
      case "Escape":
        dismissed.current = trigger.start;
        setTrigger(undefined);
        return true;
    }
    return false;
  }

  /** The "files" answer to the latest search; older ones are dropped. */
  function setSearchResults(
    id: number,
    files: FileSuggestion[],
    terminals: TerminalSuggestion[] | undefined,
    problems: ProblemSuggestion[] | undefined,
  ): void {
    if (id !== searchId.current) return;
    setFiles(files);
    setTerminals(terminals ?? []);
    setProblems(problems ?? []);
  }

  return { suggestions, shown, select: setSelected, pick, onKey, refresh, close, setSearchResults, setSkills };
}

/** The popup's rows. */
export function SuggestionList({
  suggestions,
  shown,
  select,
  pick,
}: {
  suggestions: Suggestion[];
  shown: number;
  select: (index: number) => void;
  pick: (s: Suggestion) => void;
}) {
  return (
    <div id="suggest" role="listbox">
      {suggestions.map((s, i) => (
        <div
          key={s.key}
          role="option"
          className="suggest-item"
          aria-selected={i === shown}
          ref={i === shown ? (n) => n?.scrollIntoView({ block: "nearest" }) : undefined}
          // Keeps the focus in the editor.
          onMouseDown={(e) => {
            e.preventDefault();
            pick(s);
          }}
          onMouseMove={() => i !== shown && select(i)}
        >
          <span className="suggest-label">{s.label}</span>
          {s.detail && <span className="suggest-detail">{s.detail}</span>}
        </div>
      ))}
    </div>
  );
}
