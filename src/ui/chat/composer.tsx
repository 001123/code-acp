import { EditorContent, useEditor } from "@tiptap/react";
import { useEffect, useLayoutEffect, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import type { Attachment, Draft, PromptPart, QueuedInfo, TabInfo, WorkspaceFolderInfo } from "../../chat/protocol";
import type { FileSuggestion, SkillSuggestion } from "../../completions";
import type { TerminalSuggestion } from "../../terminalContext";
import { Icon } from "../icon";
import { useL10n, type Translate } from "../l10n";
import arrowUpIcon from "@tabler/icons/outline/arrow-up.svg";
import paperclipIcon from "@tabler/icons/outline/paperclip.svg";
import stopIcon from "@tabler/icons/filled/player-stop.svg";
import clockIcon from "@tabler/icons/outline/clock.svg";
import pencilIcon from "@tabler/icons/outline/pencil.svg";
import sendNowIcon from "@tabler/icons/outline/player-track-next.svg";
import xIcon from "@tabler/icons/outline/x.svg";
import { attachmentKey, attachmentTitle, imageSrc, nameFromUri, urisFrom } from "./attachments";
import type { Hover, Preview } from "./context";
import { composerExtensions, flatText, offsetAt, replaceText, resetText, setCaret, textOf, tokensIn, type TokenInfo } from "./editor";
import { FENCE, styleLines } from "./livePreview";
import { post } from "./post";
import { byName, triggerIn, type Suggestion, type Trigger } from "./suggestions";
import { isTabDrag, type TabState } from "./tabs";
import { splitTokens } from "../markdown";
import { AgentPanel, FolderSelect, type AgentChoices } from "./toolbar";

const MAX_DATA_BYTES = 20 * 1024 * 1024;

/** What the composer of one tab holds. */
interface Content {
  text: string;
  inline: Map<string, Attachment>;
  attachments: Attachment[];
}

/** The composer content a sent or queued message is made of. */
function contentOf(parts: ReadonlyArray<PromptPart>): Content {
  const content: Content = { text: "", inline: new Map(), attachments: [] };
  for (const part of parts) {
    if (typeof part === "string") {
      content.text += part;
      continue;
    }
    const { token, ...attachment } = part;
    if (token) {
      content.text += token;
      content.inline.set(token, attachment);
    } else {
      content.attachments.push(attachment);
    }
  }
  return content;
}

/** `added` after `content`, its tokens renamed where `content` already uses them. */
function appendContent(content: Content, added: Content): Content {
  let text = added.text;
  const inline = new Map(content.inline);
  for (const [token, attachment] of added.inline) {
    let name = token;
    for (let n = 2; inline.has(name); n++) name = `${token} (${n})`;
    if (name !== token) text = text.split(token).join(name);
    inline.set(name, attachment);
  }
  const lead = content.text.trim() ? `${content.text.trimEnd()}\n\n` : "";
  return { text: lead + text, inline, attachments: [...content.attachments, ...added.attachments] };
}

/** Tokens drawn as chips in the editor. */
function tokenInfos(inline: Map<string, Attachment>): TokenInfo[] {
  return [...inline].map(([token, a]) => ({ token, image: imageSrc(a) !== undefined }));
}

export interface ComposerOptions {
  /** The active tab; also as a ref for callbacks registered once (drop, FileReader). */
  active: number | undefined;
  activeRef: MutableRefObject<number | undefined>;
  tabs: TabInfo[];
  states: Record<number, TabState>;
  /** The active tab's attachments that are not inline in the text. */
  attachments: Attachment[];
  /** The active tab's queued messages. */
  queue: QueuedInfo[];
  /** The turn whose message the active tab's composer is editing. */
  editing: number | undefined;
  commands: TabState["commands"];
  busy: boolean;
  agents: AgentChoices;
  /** The workspace folders a tab can run in. */
  folders: ReadonlyArray<WorkspaceFolderInfo>;
  /** The file "include open file" sends: the active editor's, workspace-relative. */
  activeFile: string | undefined;
  /** The extension runs on another machine (Remote SSH, WSL, containers), which can't read paths on this one. */
  remote: boolean;
  update: (tab: number | undefined, f: (s: TabState) => TabState) => void;
  error: (key: Parameters<Translate>[0], ...args: unknown[]) => void;
  setPreview: (preview: Preview | undefined) => void;
  setHover: (hover: Hover | undefined | ((h: Hover | undefined) => Hover | undefined)) => void;
  /** Shown before the stop and send buttons. */
  settings: ReactNode;
  /** The session's config options, shown in the agent panel. */
  agentConfig: ReactNode;
}

/** The message composer: its state and logic, and the form to render. */
export function useComposer(options: ComposerOptions) {
  const { active, activeRef, tabs, states, attachments, queue, editing, commands, busy, agents, folders, activeFile, remote, update, error, setPreview, setHover, settings, agentConfig } =
    options;
  const { t } = useL10n();
  const [includeFile, setIncludeFile] = useState(false);
  const [dragging, setDragging] = useState(false);
  /** Handlers of the latest render, for the editor's callbacks, which are registered once. */
  const handlers = useRef<{ update(): void; select(): void; keyDown(e: KeyboardEvent): boolean; paste(e: ClipboardEvent): boolean }>(undefined);
  const placeholder = useRef(t("chat.placeholder"));
  placeholder.current = t("chat.placeholder");
  const editor = useEditor({
    extensions: composerExtensions(() => placeholder.current),
    immediatelyRender: true,
    // The webview CSP allows no inline styles; media/chat.css has what the editor needs.
    injectCSS: false,
    editorProps: {
      attributes: { id: "input", role: "textbox", "aria-multiline": "true", "aria-label": placeholder.current },
      handleKeyDown: (_, e) => handlers.current?.keyDown(e) ?? false,
      handlePaste: (_, e) => handlers.current?.paste(e) ?? false,
      // Copies keep the lines as typed; the default puts a blank line between paragraphs.
      clipboardTextSerializer: (slice) => slice.content.textBetween(0, slice.content.size, "\n", (leaf) => leaf.attrs.token ?? ""),
      // Drops are handled for the whole view, in the capture listener below.
      handleDOMEvents: { drop: () => true },
    },
    onUpdate: () => handlers.current?.update(),
    onSelectionUpdate: () => handlers.current?.select(),
    onBlur: () => setTrigger(undefined),
  });
  const form = useRef<HTMLFormElement>(null);
  /** Unsent text per tab; the editor holds the active tab's. */
  const drafts = useRef(new Map<number, string>());
  const shownDraft = useRef<number>(undefined);
  /** A draft not yet sent to the extension, which keeps it across reloads. */
  const pendingDraft = useRef<{ tab: number; draft: Draft; timer: ReturnType<typeof setTimeout> }>(undefined);
  /** Per tab, the tokens and attachments last sent with a draft; while they stay the same, only the text goes out. */
  const sentAttachments = useRef(new Map<number, unknown[]>());
  /** Tabs whose saved draft was taken; later "tabs" messages don't overwrite what was typed since. */
  const seeded = useRef(new Set<number>());
  /** Per tab editing a sent message, what its composer held before; it comes back once the edit is sent or cancelled. */
  const beforeEdit = useRef(new Map<number, Content>());

  const statesRef = useRef(states);
  statesRef.current = states;
  /** For the drop listener, registered once. */
  const remoteRef = useRef(remote);
  remoteRef.current = remote;

  /** Files and snippets per tab, by the token that stands for them in the composer text. */
  const inline = useRef(new Map<number, Map<string, Attachment>>());

  function inlineOf(tab: number): Map<string, Attachment> {
    let map = inline.current.get(tab);
    if (!map) inline.current.set(tab, (map = new Map()));
    return map;
  }

  /** Adds `a` as a token at the caret, or in place of the typed trigger `at` (which also gives the sigil). */
  function addAttachment(a: Attachment, at?: Trigger): void {
    const tab = activeRef.current;
    if (tab === undefined) {
      update(tab, (s) => ({ ...s, attachments: [...s.attachments, a] }));
      return;
    }
    const { view } = editor;
    const { doc, selection } = view.state;
    const start = at?.start ?? offsetAt(doc, selection.from);
    const end = at?.end ?? offsetAt(doc, selection.to);
    view.focus();
    // Attachments go inline as a token; a file already in the text is not added again.
    const key = attachmentKey(a);
    const tokens = inlineOf(tab);
    const shown = tokensIn(doc);
    for (const [token, x] of tokens) {
      if (!shown.has(token)) tokens.delete(token);
      else if (key !== undefined && attachmentKey(x) === key) {
        if (at) replaceText(view, start, end, "");
        return;
      }
    }
    const sigil = at?.sigil ?? "@";
    let token = `${sigil}${a.name}`;
    for (let n = 2; tokens.has(token); n++) token = `${sigil}${a.name} (${n})`;
    tokens.set(token, a);
    const space = start > 0 && !/\s/.test(flatText(doc)[start - 1]!) ? " " : "";
    replaceText(view, start, end, `${space}${token} `, [{ token, image: imageSrc(a) !== undefined }]);
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
  function suggestKey(e: KeyboardEvent): boolean {
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

  /** The editor's flat text and the selection as offsets in it. */
  function selectionText(): { text: string; from: number; to: number } {
    const { doc, selection } = editor.state;
    return { text: flatText(doc), from: offsetAt(doc, selection.from), to: offsetAt(doc, selection.to) };
  }

  /** Shift+Enter in a Markdown list item starts the next item; in an empty one, ends the list. True when the key was used. */
  function continueList(): boolean {
    const { text, from: caret, to } = selectionText();
    if (caret !== to) return false;
    const start = text.lastIndexOf("\n", caret - 1) + 1;
    const line = text.slice(start, caret);
    const m = /^(\s*)(?:([-*+])|(\d+)([.)]))(\s+)(\[[ xX]\]\s+)?/.exec(line);
    if (!m) return false;
    const end = text.indexOf("\n", caret);
    if (m[0].length === line.length && !text.slice(caret, end < 0 ? undefined : end).trim()) {
      replaceText(editor.view, start, caret, "");
    } else {
      const marker = m[2] ?? `${Number(m[3]) + 1}${m[4]}`;
      replaceText(editor.view, caret, caret, `\n${m[1]}${marker}${m[5]}${m[6] ? "[ ] " : ""}`);
    }
    return true;
  }

  /** Inserts `text` as a Markdown quote at the caret. */
  function quote(text: string): void {
    const { text: current, from, to } = selectionText();
    const before = current.slice(0, from);
    const lead = before && !before.endsWith("\n") ? "\n\n" : "";
    const quoted = text.trimEnd().split(/\r?\n/).map((l) => (l ? `> ${l}` : "> ")).join("\n");
    replaceText(editor.view, from, to, `${lead}${quoted}\n\n`);
    editor.view.focus();
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

  /** What the composer of `tab` holds, shown or not. */
  function contentIn(tab: number): Content {
    const text = tab === shownDraft.current ? textOf(editor.state.doc) : (drafts.current.get(tab) ?? "");
    return { text, inline: new Map(inlineOf(tab)), attachments: statesRef.current[tab]?.attachments ?? [] };
  }

  function setContent(tab: number, content: Content): void {
    inline.current.set(tab, new Map(content.inline));
    update(tab, (s) => ({ ...s, attachments: content.attachments }));
    if (tab !== shownDraft.current) {
      // Shown, and saved, when the tab is next selected.
      drafts.current.set(tab, content.text);
      return;
    }
    resetText(editor.view, content.text, tokenInfos(content.inline));
    editor.view.focus();
    saveDraft(content.text);
  }

  /**
   * Puts a message back in the composer of `tab`: a queued one after what is there, or a sent one (with `rewind`, its
   * turn) in place of it until the edit is sent or cancelled.
   */
  function load(tab: number, parts: ReadonlyArray<PromptPart>, rewind?: number): void {
    const loaded = contentOf(parts);
    if (rewind === undefined) {
      setContent(tab, appendContent(contentIn(tab), loaded));
      return;
    }
    if (!beforeEdit.current.has(tab)) beforeEdit.current.set(tab, contentIn(tab));
    update(tab, (s) => ({ ...s, editing: rewind }));
    setContent(tab, loaded);
  }

  /** Ends editing a sent message: the composer gets back what it held before. */
  function endEdit(tab: number): void {
    const before = beforeEdit.current.get(tab);
    if (!before) return;
    beforeEdit.current.delete(tab);
    update(tab, (s) => ({ ...s, editing: undefined }));
    setContent(tab, before);
  }

  /** The "files" answer to the latest search; older ones are dropped. */
  function setSearchResults(id: number, files: FileSuggestion[], terminals: TerminalSuggestion[] | undefined): void {
    if (id !== searchId.current) return;
    setFiles(files);
    setTerminals(terminals ?? []);
  }

  const focus = () => editor.view.focus();

  // Swaps the composer text when another tab becomes active.
  useLayoutEffect(() => {
    if (shownDraft.current === active) return;
    if (shownDraft.current !== undefined) drafts.current.set(shownDraft.current, textOf(editor.state.doc));
    for (const id of drafts.current.keys()) {
      if (!tabs.some((x) => x.id === id)) drafts.current.delete(id);
    }
    for (const id of inline.current.keys()) {
      if (!tabs.some((x) => x.id === id)) inline.current.delete(id);
    }
    for (const id of sentAttachments.current.keys()) {
      if (!tabs.some((x) => x.id === id)) sentAttachments.current.delete(id);
    }
    for (const id of beforeEdit.current.keys()) {
      if (!tabs.some((x) => x.id === id)) beforeEdit.current.delete(id);
    }
    const text = (active !== undefined && drafts.current.get(active)) || "";
    resetText(editor.view, text, active !== undefined ? tokenInfos(inlineOf(active)) : []);
    shownDraft.current = active;
    setTrigger(undefined);
    saveDraft(text);
    editor.view.focus();
  }, [active]);

  // Drops anywhere in the view attach files; the editor leaves drops to this listener.
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
      if (!takeTransfer(e.dataTransfer)) {
        const text = e.dataTransfer.getData("text/plain");
        if (text) insertText(text);
      }
      editor.view.focus();
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

  /** Puts `text` in place of the selection. */
  function insertText(text: string): void {
    const { from, to } = selectionText();
    replaceText(editor.view, from, to, text.replace(/\r\n?/g, "\n"));
  }

  function onPaste(e: ClipboardEvent): boolean {
    const dt = e.clipboardData;
    if (!dt) return false;
    // Files (e.g. screenshots) become attachments.
    if (Array.from(dt.items).some((it) => it.kind === "file") && takeTransfer(dt)) return true;
    // Copies from the composer keep their tokens; anything else goes in as the Markdown it is.
    if (dt.getData("text/html").includes("data-pm-slice")) return false;
    const text = dt.getData("text/plain");
    if (!text) return false;
    insertText(text);
    return true;
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
    saveDraft(textOf(editor.state.doc));
  }, [attachments]);

  /** The image token at `target`. */
  function imageTokenAt(target: EventTarget): { src: string; name: string; token: string; rect: DOMRect } | undefined {
    const mark = target instanceof Element ? target.closest<HTMLElement>("mark.token.image") : null;
    if (!mark || active === undefined) return undefined;
    const token = mark.dataset.token!;
    const a = inlineOf(active).get(token);
    const src = a && imageSrc(a);
    return a && src ? { src, name: a.name, token, rect: mark.getBoundingClientRect() } : undefined;
  }

  /**
   * Enter in fenced code adds a line; on the opening fence it also closes the block. Shift+Enter, or Enter on the
   * block's empty last line, leaves it (closing it if open). Down on a block that ends the text adds a line after it.
   * True when the key was used.
   */
  function codeKey(key: "Enter" | "ArrowDown", shift: boolean): boolean {
    const { text, from, to } = selectionText();
    if (from !== to) return false;
    const lines = text.split("\n");
    const styles = styleLines(lines);
    let i = 0;
    let start = 0;
    while (start + lines[i]!.length < from) start += lines[i++]!.length + 1;
    const { block, fence } = styles[i]!;
    if (fence === undefined) return false;
    const view = editor.view;
    const lineEnd = start + lines[i]!.length;
    const close = block === "fence-close" ? i : styles.findIndex((s, j) => j > i && s.block === "fence-close" && s.fence === fence);
    if (key === "ArrowDown") {
      if (i !== lines.length - 1) return false;
      replaceText(view, text.length, text.length, "\n");
      return true;
    }
    if (block === "fence-open" && !shift) {
      insertText("\n");
      if (close < 0 && from === lineEnd) {
        replaceText(view, from + 1, from + 1, `\n${FENCE.exec(lines[i]!)![1]}`);
        setCaret(view, from + 1);
      }
      return true;
    }
    const emptyLast = block === "codeblock" && lines[i] === "" && (close < 0 ? i === lines.length - 1 : i === close - 1);
    if (!shift && !emptyLast && block !== "fence-close") {
      insertText("\n");
      return true;
    }
    if (close < 0) {
      // The empty last line becomes the closing fence.
      const marker = FENCE.exec(lines[fence]!)![1];
      if (emptyLast) replaceText(view, start, lineEnd, `${marker}\n`);
      else replaceText(view, lineEnd, lineEnd, `\n${marker}\n`);
      return true;
    }
    let closeEnd = lines.slice(0, close + 1).join("\n").length;
    if (emptyLast) {
      replaceText(view, start - 1, lineEnd, "");
      closeEnd -= lineEnd - start + 1;
    }
    if (close + 1 < lines.length && lines[close + 1] === "") setCaret(view, closeEnd + 1);
    else replaceText(view, closeEnd, closeEnd, "\n");
    return true;
  }

  function onKeyDown(e: KeyboardEvent): boolean {
    if (suggestKey(e)) return true;
    if (e.isComposing) return false;
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      submit(true);
      return true;
    }
    if ((e.key === "Enter" || (e.key === "ArrowDown" && !e.shiftKey && !e.altKey)) && codeKey(e.key, e.shiftKey)) return true;
    if (e.key === "Enter" && e.shiftKey) {
      if (!continueList()) insertText("\n");
      return true;
    }
    if (e.key === "Enter") {
      submit(false);
      return true;
    }
    if (e.key === "Escape" && editing !== undefined && active !== undefined) {
      endEdit(active);
      return true;
    }
    return false;
  }

  handlers.current = {
    update: () => {
      saveDraft(textOf(editor.state.doc));
      refreshTrigger();
    },
    select: refreshTrigger,
    keyDown: onKeyDown,
    paste: onPaste,
  };

  /** Sends the composer content; while the agent works it is queued, unless `now`. An edit replaces its message. */
  function submit(now: boolean): void {
    if (active === undefined) return;
    const text = textOf(editor.state.doc);
    const tokens = [...inlineOf(active)].map(([token, a]) => ({ ...a, token }));
    const parts: PromptPart[] = [...splitTokens(text, tokens), ...attachments];
    if (parts.every((p) => typeof p === "string" && !p.trim())) return;
    post({ type: "send", tab: active, parts, includeActiveFile: includeFile, now: now || undefined, rewind: editing });
    if (editing !== undefined) {
      endEdit(active);
      return;
    }
    resetText(editor.view, "", []);
    saveDraft("");
    update(active, (s) => ({ ...s, attachments: [] }));
    inline.current.delete(active);
  }

  const element: ReactNode = (
    <form
      id="composer"
      ref={form}
      data-busy={busy || undefined}
      onSubmit={(e) => {
        e.preventDefault();
        submit(false);
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
              // Keeps the focus in the editor.
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
      {active !== undefined && queue.length > 0 && (
        <div id="queue" aria-label={t("chat.queued")}>
          {queue.map((q) => (
            <div key={q.id} className="queued">
              <Icon svg={clockIcon} />
              <span className="queued-text" title={q.text}>
                {q.text.trim() || q.attachments.join(", ")}
              </span>
              {q.text.trim() && q.attachments.length > 0 && (
                <span className="queued-more">{t("chat.queuedAttachments", q.attachments.length)}</span>
              )}
              <button
                type="button"
                className="icon-btn small"
                title={t("chat.sendNow")}
                aria-label={t("chat.sendNow")}
                onClick={() => post({ type: "sendQueuedNow", tab: active, id: q.id })}
              >
                <Icon svg={sendNowIcon} />
              </button>
              <button
                type="button"
                className="icon-btn small"
                title={t("chat.editQueued")}
                aria-label={t("chat.editQueued")}
                onClick={() => post({ type: "unqueue", tab: active, id: q.id, edit: true })}
              >
                <Icon svg={pencilIcon} />
              </button>
              <button
                type="button"
                className="icon-btn small"
                title={t("chat.removeQueued")}
                aria-label={t("chat.removeQueued")}
                onClick={() => post({ type: "unqueue", tab: active, id: q.id, edit: false })}
              >
                <Icon svg={xIcon} />
              </button>
            </div>
          ))}
        </div>
      )}
      {active !== undefined && editing !== undefined && (
        <div id="editing">
          <Icon svg={pencilIcon} />
          <span className="editing-text">{t("chat.editing")}</span>
          <button
            type="button"
            className="icon-btn small"
            title={t("chat.cancelEdit")}
            aria-label={t("chat.cancelEdit")}
            onClick={() => endEdit(active)}
          >
            <Icon svg={xIcon} />
          </button>
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
      <div
        id="input-box"
        onMouseMove={(e) => {
          const hit = imageTokenAt(e.target);
          // Keep the same object while on the same token, so moving within it doesn't re-render.
          setHover((h) => (hit ? (h?.src === hit.src && h.rect.top === hit.rect.top ? h : hit) : undefined));
        }}
        onMouseLeave={() => setHover(undefined)}
        onScrollCapture={() => setHover(undefined)}
        onClick={(e) => {
          const hit = imageTokenAt(e.target);
          if (!hit) return;
          setHover(undefined);
          const tab = active!;
          setPreview({
            src: hit.src,
            name: hit.name,
            replace: (b) => {
              inlineOf(tab).set(hit.token, b);
              if (tab === shownDraft.current) saveDraft(textOf(editor.state.doc));
            },
          });
        }}
      >
        <EditorContent editor={editor} />
      </div>
      <div id="actions">
        <AgentPanel tab={tabs.find((x) => x.id === active)} choices={agents}>
          {agentConfig}
        </AgentPanel>
        <FolderSelect tab={tabs.find((x) => x.id === active)} folders={folders} />
        <label title={activeFile ? t("chat.includeFileNamed", activeFile) : t("chat.includeFile")}>
          <input type="checkbox" id="include-file" checked={includeFile} onChange={(e) => setIncludeFile(e.target.checked)} />
          <Icon svg={paperclipIcon} />
          <span className="label-text">{activeFile ? activeFile.split("/").pop() : t("chat.includeFile")}</span>
        </label>
        <span className="spacer" />
        {settings}
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
          title={t(busy ? "chat.queueTitle" : "chat.sendTitle")}
          aria-label={t("chat.send")}
        >
          <Icon svg={arrowUpIcon} />
        </button>
      </div>
    </form>
  );

  return { element, dragging, addAttachment, quote, seed, setSearchResults, setSkills, focus, load, endEdit };
}
