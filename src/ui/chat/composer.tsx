import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent as ReactKeyboardEvent, type MutableRefObject, type ReactNode } from "react";
import type { Attachment, Draft, PromptPart, TabInfo, WorkspaceFolderInfo } from "../../chat/protocol";
import type { FileSuggestion, SkillSuggestion } from "../../completions";
import type { TerminalSuggestion } from "../../terminalContext";
import { Icon } from "../icon";
import { useL10n, type Translate } from "../l10n";
import arrowUpIcon from "@tabler/icons/outline/arrow-up.svg";
import paperclipIcon from "@tabler/icons/outline/paperclip.svg";
import stopIcon from "@tabler/icons/filled/player-stop.svg";
import { attachmentKey, attachmentTitle, editText, imageSrc, nameFromUri, urisFrom } from "./attachments";
import type { Hover, Preview } from "./context";
import { post } from "./post";
import { byName, triggerIn, type Suggestion, type Trigger } from "./suggestions";
import { isTabDrag, type TabState } from "./tabs";
import { splitTokens, Tokens } from "./tokens";
import { AgentSelect, FolderSelect, type AgentChoices } from "./toolbar";

const MAX_DATA_BYTES = 20 * 1024 * 1024;

export interface ComposerOptions {
  /** The active tab; also as a ref for callbacks registered once (drop, FileReader). */
  active: number | undefined;
  activeRef: MutableRefObject<number | undefined>;
  tabs: TabInfo[];
  states: Record<number, TabState>;
  /** The active tab's attachments that are not inline in the text. */
  attachments: Attachment[];
  commands: TabState["commands"];
  busy: boolean;
  agents: AgentChoices;
  /** The workspace folders a tab can run in. */
  folders: ReadonlyArray<WorkspaceFolderInfo>;
  /** The extension runs on another machine (Remote SSH, WSL, containers), which can't read paths on this one. */
  remote: boolean;
  update: (tab: number | undefined, f: (s: TabState) => TabState) => void;
  error: (key: Parameters<Translate>[0], ...args: unknown[]) => void;
  setPreview: (preview: Preview | undefined) => void;
  setHover: (hover: Hover | undefined | ((h: Hover | undefined) => Hover | undefined)) => void;
}

/** The message composer: its state and logic, and the form to render. */
export function useComposer(options: ComposerOptions) {
  const { active, activeRef, tabs, states, attachments, commands, busy, agents, folders, remote, update, error, setPreview, setHover } = options;
  const { t } = useL10n();
  const [includeFile, setIncludeFile] = useState(false);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const form = useRef<HTMLFormElement>(null);
  /** Unsent text per tab; the textarea holds the active tab's. */
  const drafts = useRef(new Map<number, string>());
  const shownDraft = useRef<number>(undefined);
  /** A draft not yet sent to the extension, which keeps it across reloads. */
  const pendingDraft = useRef<{ tab: number; draft: Draft; timer: ReturnType<typeof setTimeout> }>(undefined);
  /** Per tab, the tokens and attachments last sent with a draft; while they stay the same, only the text goes out. */
  const sentAttachments = useRef(new Map<number, unknown[]>());
  /** Tabs whose saved draft was taken; later "tabs" messages don't overwrite what was typed since. */
  const seeded = useRef(new Set<number>());

  const statesRef = useRef(states);
  statesRef.current = states;
  /** For the drop listener, registered once. */
  const remoteRef = useRef(remote);
  remoteRef.current = remote;

  /** Files and snippets per tab, by the token that stands for them in the composer text. */
  const inline = useRef(new Map<number, Map<string, Attachment>>());
  /** Mirrors the textarea for the token highlight behind it. */
  const [inputText, setInputText] = useState("");
  const backdrop = useRef<HTMLDivElement>(null);

  function inlineOf(tab: number): Map<string, Attachment> {
    let map = inline.current.get(tab);
    if (!map) inline.current.set(tab, (map = new Map()));
    return map;
  }

  /** Adds `a` as a token at the caret, or in place of the typed trigger `at` (which also gives the sigil). */
  function addAttachment(a: Attachment, at?: Trigger): void {
    const tab = activeRef.current;
    const el = input.current;
    if (tab === undefined || !el) {
      update(tab, (s) => ({ ...s, attachments: [...s.attachments, a] }));
      return;
    }
    const start = at?.start ?? el.selectionStart;
    const end = at?.end ?? el.selectionEnd;
    // Attachments go inline as a token; a file already in the text is not added again.
    const key = attachmentKey(a);
    const tokens = inlineOf(tab);
    for (const [token, x] of tokens) {
      if (!el.value.includes(token)) tokens.delete(token);
      else if (key !== undefined && attachmentKey(x) === key) {
        if (at) editText(el, "", start, end);
        autosize();
        return;
      }
    }
    const sigil = at?.sigil ?? "@";
    let token = `${sigil}${a.name}`;
    for (let n = 2; tokens.has(token); n++) token = `${sigil}${a.name} (${n})`;
    tokens.set(token, a);
    const space = start > 0 && !/\s/.test(el.value[start - 1]!) ? " " : "";
    editText(el, `${space}${token} `, start, end);
    autosize();
  }

  const [trigger, setTrigger] = useState<Trigger>();
  const [selected, setSelected] = useState(0);
  const [files, setFiles] = useState<FileSuggestion[]>([]);
  const [terminals, setTerminals] = useState<TerminalSuggestion[]>([]);
  const [skills, setSkills] = useState<SkillSuggestion[]>([]);
  /** Id of the latest file search; older answers are dropped. */
  const searchId = useRef(0);
  /** Start of the trigger closed with Escape; it stays closed until the caret leaves it. */
  const dismissed = useRef<number>(undefined);

  /** Opens, updates or closes the popup for the text before the caret. */
  function refreshTrigger(): void {
    const el = input.current;
    let next = el ? triggerIn(el) : undefined;
    // The text of a token already placed is not a trigger.
    if (next && active !== undefined && [...inlineOf(active).keys()].some((x) => el!.value.startsWith(x, next!.start))) next = undefined;
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
      }
      post({ type: "searchFiles", id: ++searchId.current, query: next.query });
    }
    if (next?.sigil === "$" && trigger?.sigil !== "$") post({ type: "listSkills" });
  }

  /** Replaces the typed trigger with `text`. */
  function replaceTrigger(at: Trigger, text: string): void {
    const el = input.current;
    if (!el) return;
    editText(el, text, at.start, at.end);
    autosize();
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
    input.current?.focus();
  }

  /** Popup keys; true when the key was used. */
  function suggestKey(e: ReactKeyboardEvent<HTMLTextAreaElement>): boolean {
    if (!trigger || suggestions.length === 0 || e.nativeEvent.isComposing) return false;
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

  /** Backspace right after a token deletes the whole token. */
  function deleteToken(): boolean {
    const el = input.current;
    const tab = activeRef.current;
    if (!el || tab === undefined || el.selectionStart !== el.selectionEnd) return false;
    const before = el.value.slice(0, el.selectionStart);
    const token = [...inlineOf(tab).keys()].sort((a, b) => b.length - a.length).find((x) => before.endsWith(x));
    if (!token) return false;
    editText(el, "", el.selectionStart - token.length, el.selectionStart);
    autosize();
    return true;
  }

  /** Inserts `text` as a Markdown quote at the caret. */
  function quote(text: string): void {
    const el = input.current;
    if (!el) return;
    const before = el.value.slice(0, el.selectionStart);
    const lead = before && !before.endsWith("\n") ? "\n\n" : "";
    const quoted = text.trimEnd().split(/\r?\n/).map((l) => (l ? `> ${l}` : ">")).join("\n");
    editText(el, `${lead}${quoted}\n\n`, el.selectionStart, el.selectionEnd);
    el.focus();
    autosize();
  }

  function readFile(file: File): void {
    if (file.size > MAX_DATA_BYTES) {
      error("chat.tooLarge", file.name);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      addAttachment({
        kind: "data",
        name: file.name || `clipboard-${Date.now()}.${(file.type.split("/")[1] || "bin").replace(/\W.*$/, "")}`,
        mimeType: file.type,
        data: result.slice(result.indexOf(",") + 1),
      });
    };
    reader.onerror = () => error("chat.readFailed", file.name);
    reader.readAsDataURL(file);
  }

  /** Handles a DataTransfer from drop or paste. Returns true when something was attached. */
  function takeTransfer(dt: DataTransfer): boolean {
    const items = Array.from(dt.items ?? []).filter((it) => it.kind === "file");
    // VS Code's own list (Explorer, editor tabs) names files where the extension runs; files dropped from the
    // OS of a remote window are on this machine, so they go as their bytes.
    const local = remoteRef.current && items.length > 0 && !dt.types.includes("application/vnd.code.uri-list");
    const uris = local ? [] : urisFrom(dt);
    if (uris.length) {
      for (const uri of uris) addAttachment({ kind: "uri", uri, name: nameFromUri(uri) });
      return true;
    }
    if (!items.length) return false;
    for (const item of items) {
      if (item.webkitGetAsEntry?.()?.isDirectory) {
        error("chat.externalFolder");
        continue;
      }
      const file = item.getAsFile();
      if (file) readFile(file);
    }
    return true;
  }

  /** Takes the saved drafts of tabs not seen before (after a reload the extension holds them). */
  function seed(list: TabInfo[]): void {
    for (const { id, draft } of list) {
      if (seeded.current.has(id)) continue;
      seeded.current.add(id);
      if (!draft) continue;
      drafts.current.set(id, draft.text);
      inline.current.set(id, new Map(draft.inline.map((x) => [x.token, x.attachment])));
      if (draft.attachments.length > 0) update(id, (s) => ({ ...s, attachments: draft.attachments }));
    }
  }

  /** The "files" answer to the latest search; older ones are dropped. */
  function setSearchResults(id: number, files: FileSuggestion[], terminals: TerminalSuggestion[] | undefined): void {
    if (id !== searchId.current) return;
    setFiles(files);
    setTerminals(terminals ?? []);
  }

  const focus = () => input.current?.focus();

  // Swaps the composer text when another tab becomes active.
  useLayoutEffect(() => {
    const el = input.current;
    if (!el || shownDraft.current === active) return;
    if (shownDraft.current !== undefined) drafts.current.set(shownDraft.current, el.value);
    for (const id of drafts.current.keys()) {
      if (!tabs.some((x) => x.id === id)) drafts.current.delete(id);
    }
    for (const id of inline.current.keys()) {
      if (!tabs.some((x) => x.id === id)) inline.current.delete(id);
    }
    for (const id of sentAttachments.current.keys()) {
      if (!tabs.some((x) => x.id === id)) sentAttachments.current.delete(id);
    }
    el.value = (active !== undefined && drafts.current.get(active)) || "";
    shownDraft.current = active;
    setTrigger(undefined);
    autosize();
    el.focus();
  }, [active]);

  // Drops anywhere in the view attach files; capture so the textarea's own drop handling never runs.
  useEffect(() => {
    let depth = 0;
    const enter = (e: DragEvent) => {
      if (isTabDrag(e)) return;
      e.preventDefault();
      depth++;
      setDragging(true);
    };
    const leave = (e: DragEvent) => {
      if (isTabDrag(e)) return;
      if (--depth <= 0) {
        depth = 0;
        setDragging(false);
      }
    };
    const over = (e: DragEvent) => {
      if (isTabDrag(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const drop = (e: DragEvent) => {
      if (isTabDrag(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      if (!e.dataTransfer) return;
      const el = input.current;
      if (!takeTransfer(e.dataTransfer) && el) {
        const text = e.dataTransfer.getData("text/plain");
        if (text) editText(el, text, el.selectionStart, el.selectionEnd);
        autosize();
      }
      el?.focus();
    };
    window.addEventListener("dragenter", enter, true);
    window.addEventListener("dragleave", leave, true);
    window.addEventListener("dragover", over, true);
    window.addEventListener("drop", drop, true);
    return () => {
      window.removeEventListener("dragenter", enter, true);
      window.removeEventListener("dragleave", leave, true);
      window.removeEventListener("dragover", over, true);
      window.removeEventListener("drop", drop, true);
    };
  }, []);

  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>): void {
    const dt = e.clipboardData;
    // Plain text keeps the default paste; only files (e.g. screenshots) become attachments.
    if (Array.from(dt.items).some((it) => it.kind === "file") && takeTransfer(dt)) e.preventDefault();
  }

  function autosize(): void {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
    setInputText(el.value);
    syncScroll();
    saveDraft(el.value);
  }

  function flushDraft(): void {
    const pending = pendingDraft.current;
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingDraft.current = undefined;
    const { tab, draft } = pending;
    // Attachments can be megabytes of base64; resending them on every keystroke pause is wasted work.
    const refs = [...draft.inline.flatMap((x) => [x.token, x.attachment]), ...draft.attachments];
    const last = sentAttachments.current.get(tab);
    if (last && last.length === refs.length && last.every((x, i) => x === refs[i])) {
      post({ type: "draftText", tab, text: draft.text });
      return;
    }
    sentAttachments.current.set(tab, refs);
    post({ type: "draft", tab, draft });
  }

  /** Sends the active tab's composer content to the extension, at most every 300 ms. */
  function saveDraft(text: string): void {
    const tab = activeRef.current;
    if (tab === undefined) return;
    const draft: Draft = {
      text,
      inline: [...inlineOf(tab)].filter(([token]) => text.includes(token)).map(([token, attachment]) => ({ token, attachment })),
      attachments: statesRef.current[tab]?.attachments ?? [],
    };
    if (pendingDraft.current?.tab !== tab) flushDraft();
    else clearTimeout(pendingDraft.current.timer);
    pendingDraft.current = { tab, draft, timer: setTimeout(flushDraft, 300) };
  }

  // Attachments outside the text change without an edit.
  useEffect(() => {
    if (input.current) saveDraft(input.current.value);
  }, [attachments]);

  /** The image token drawn under the pointer; the backdrop sits behind the textarea, so hit-test its rects. */
  function imageTokenAt(x: number, y: number): { src: string; name: string; token: string; rect: DOMRect } | undefined {
    if (active === undefined) return undefined;
    for (const mark of backdrop.current?.querySelectorAll<HTMLElement>("mark.image") ?? []) {
      for (const rect of mark.getClientRects()) {
        if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue;
        const token = mark.dataset.token!;
        const a = inlineOf(active).get(token);
        const src = a && imageSrc(a);
        return a && src ? { src, name: a.name, token, rect } : undefined;
      }
    }
    return undefined;
  }

  function syncScroll(): void {
    if (backdrop.current && input.current) backdrop.current.scrollTop = input.current.scrollTop;
  }

  function submit(): void {
    const el = input.current;
    if (!el || active === undefined) return;
    const text = el.value;
    const tokens = [...inlineOf(active)].map(([token, a]) => ({ ...a, token }));
    const parts: PromptPart[] = [...splitTokens(text, tokens), ...attachments];
    if (parts.every((p) => typeof p === "string" && !p.trim())) return;
    el.value = "";
    autosize();
    post({ type: "send", tab: active, parts, includeActiveFile: includeFile });
    update(active, (s) => ({ ...s, attachments: [] }));
    inline.current.delete(active);
  }

  const element: ReactNode = (
    <form
      id="composer"
      ref={form}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {suggestions.length > 0 && (
        <div id="suggest" role="listbox">
          {suggestions.map((s, i) => (
            <div
              key={s.key}
              role="option"
              className="suggest-item"
              aria-selected={i === shown}
              ref={i === shown ? (n) => n?.scrollIntoView({ block: "nearest" }) : undefined}
              // Keeps the focus in the textarea.
              onMouseDown={(e) => {
                e.preventDefault();
                pick(s);
              }}
              onMouseMove={() => i !== shown && setSelected(i)}
            >
              <span className="suggest-label">{s.label}</span>
              {s.detail && <span className="suggest-detail">{s.detail}</span>}
            </div>
          ))}
        </div>
      )}
      <div id="attachments">
        {attachments.map((a, i) => (
          <span key={attachmentKey(a) ?? i} className="chip" title={attachmentTitle(t, a)}>
            {imageSrc(a) && (
              <img
                className="chip-preview"
                src={imageSrc(a)}
                title={t("chat.previewImage")}
                onClick={() =>
                  setPreview({
                    src: imageSrc(a)!,
                    name: a.name,
                    replace: (b) => update(active, (s) => ({ ...s, attachments: s.attachments.map((x) => (x === a ? b : x)) })),
                  })
                }
              />
            )}
            <span>{a.name}</span>
            <button
              type="button"
              className="chip-remove"
              title={t("chat.removeAttachment")}
              onClick={() => update(active, (s) => ({ ...s, attachments: s.attachments.filter((x) => x !== a) }))}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <div id="input-box">
        {/* Same text as the textarea, transparent, so tokens get a highlight behind them. */}
        <div id="input-backdrop" ref={backdrop} aria-hidden="true">
          <Tokens
            text={inputText}
            tokens={active !== undefined ? [...inlineOf(active)].map(([token, a]) => ({ token, src: imageSrc(a) })) : []}
          />
          {"\n"}
        </div>
        <textarea
          id="input"
          ref={input}
          rows={2}
          placeholder={t("chat.placeholder")}
          title={t("chat.inputTitle")}
          onInput={() => {
            autosize();
            refreshTrigger();
          }}
          onSelect={refreshTrigger}
          onBlur={() => setTrigger(undefined)}
          onScroll={() => {
            syncScroll();
            setHover(undefined);
          }}
          onPaste={onPaste}
          onMouseMove={(e) => {
            const hit = imageTokenAt(e.clientX, e.clientY);
            e.currentTarget.style.cursor = hit ? "pointer" : "";
            // Keep the same object while on the same token, so moving within it doesn't re-render.
            setHover((h) => (hit ? (h?.src === hit.src && h.rect.top === hit.rect.top ? h : hit) : undefined));
          }}
          onMouseLeave={() => setHover(undefined)}
          onClick={(e) => {
            const hit = imageTokenAt(e.clientX, e.clientY);
            if (hit && e.currentTarget.selectionStart === e.currentTarget.selectionEnd) {
              setHover(undefined);
              const tab = active!;
              setPreview({
                src: hit.src,
                name: hit.name,
                replace: (b) => {
                  inlineOf(tab).set(hit.token, b);
                  if (input.current) saveDraft(input.current.value);
                },
              });
            }
          }}
          onKeyDown={(e) => {
            if (suggestKey(e)) {
              e.preventDefault();
            } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              form.current?.requestSubmit();
            } else if (e.key === "Backspace" && !e.nativeEvent.isComposing && deleteToken()) {
              e.preventDefault();
            }
          }}
        />
      </div>
      <div id="actions">
        <AgentSelect tab={tabs.find((x) => x.id === active)} choices={agents} />
        <FolderSelect tab={tabs.find((x) => x.id === active)} folders={folders} />
        <label title={t("chat.includeFile")}>
          <input type="checkbox" id="include-file" checked={includeFile} onChange={(e) => setIncludeFile(e.target.checked)} />
          <Icon svg={paperclipIcon} />
          <span className="label-text">{t("chat.includeFile")}</span>
        </label>
        <span className="spacer" />
        <button
          type="button"
          id="cancel"
          className="icon-btn"
          title={t("chat.stop")}
          aria-label={t("chat.stop")}
          hidden={!busy}
          onClick={() => active !== undefined && post({ type: "cancel", tab: active })}
        >
          <Icon svg={stopIcon} />
        </button>
        <button
          type="submit"
          id="send"
          className="icon-btn"
          title={t("chat.sendTitle")}
          aria-label={t("chat.send")}
          disabled={busy}
        >
          <Icon svg={arrowUpIcon} />
        </button>
      </div>
    </form>
  );

  return { element, dragging, addAttachment, quote, seed, setSearchResults, setSkills, focus };
}
