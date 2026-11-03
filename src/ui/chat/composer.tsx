import { EditorContent, useEditor } from "@tiptap/react";
import { useRef, type MutableRefObject, type ReactNode } from "react";
import type { Attachment, PromptPart, QueuedInfo, TabInfo, WorkspaceFolderInfo } from "../../chat/protocol";
import { Icon } from "../icon";
import { useL10n, type Translate } from "../l10n";
import arrowUpIcon from "@tabler/icons/outline/arrow-up.svg";
import splitIcon from "@tabler/icons/outline/arrows-split-2.svg";
import stopIcon from "@tabler/icons/filled/player-stop.svg";
import { AgentPanel, type AgentChoices } from "./agentPanel";
import { imageSrc } from "./attachments";
import { copiedImages, pastedContent } from "./clipboard";
import { addToken, pruneTokens, tokenInfos } from "./composerContent";
import { useComposerDrafts } from "./composerDrafts";
import { codeKey, continueList, paragraphEdit, quoteEdit, type Edit, type Selected } from "./composerEdits";
import { takeTransfer } from "./composerFiles";
import { AttachmentChips, EditingBar, QueuedMessages } from "./composerParts";
import { SuggestionList, useSuggestions } from "./composerSuggestions";
import type { Hover, Preview } from "./context";
import { composerExtensions, flatText, offsetAt, replaceText, setCaret, textOf, tokensIn } from "./editor";
import { useFileDrop } from "./fileDrop";
import { post } from "./post";
import type { Trigger } from "./suggestions";
import type { TabState } from "./tabs";
import { splitTokens } from "../markdown";
import { FolderSelect } from "./workspaceControls";

export interface ComposerOptions {
  /** The active tab; also as a ref for callbacks registered once (FileReader). */
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
  /** The session's model and effort, shown beside the agent button. */
  quickConfig: ReactNode;
  /** A group's comparison is shown instead of the conversation. */
  hidden: boolean;
}

/** The message composer: its state and logic, and the form to render. */
export function useComposer(options: ComposerOptions) {
  const { active, activeRef, tabs, states, attachments, queue, editing, commands, busy, agents, folders, remote, update, error, setPreview, setHover, settings, agentConfig, quickConfig, hidden } =
    options;
  const { t } = useL10n();
  /** Handlers of the latest render, for the editor's callbacks, which are registered once. */
  const handlers = useRef<{ update(): void; select(): void; blur(): void; keyDown(e: KeyboardEvent): boolean; paste(e: ClipboardEvent): boolean }>(undefined);
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
      // Drops are handled for the whole view, by useFileDrop.
      handleDOMEvents: { drop: () => true },
    },
    onUpdate: () => handlers.current?.update(),
    onSelectionUpdate: () => handlers.current?.select(),
    onBlur: () => handlers.current?.blur(),
  });
  const drafts = useComposerDrafts({ editor, active, activeRef, tabs, states, attachments, update });

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
    const token = addToken(drafts.inlineOf(tab), tokensIn(doc), a, at?.sigil ?? "@");
    if (token === undefined) {
      if (at) replaceText(view, start, end, "");
      return;
    }
    const space = start > 0 && !/\s/.test(flatText(doc)[start - 1]!) ? " " : "";
    replaceText(view, start, end, `${space}${token} `, [{ token, image: imageSrc(a) !== undefined }]);
  }

  const suggest = useSuggestions({ editor, active, commands, addAttachment });

  function selected(): Selected {
    const { doc, selection } = editor.state;
    return { text: flatText(doc), from: offsetAt(doc, selection.from), to: offsetAt(doc, selection.to) };
  }

  function apply(edits: ReadonlyArray<Edit>): void {
    for (const edit of edits) {
      if ("caret" in edit) setCaret(editor.view, edit.caret);
      else replaceText(editor.view, edit.from, edit.to, edit.text);
    }
  }

  /** Inserts `text` at the caret, as a paragraph of its own. */
  function write(text: string): void {
    apply([paragraphEdit(selected(), text)]);
    editor.view.focus();
  }

  /** Inserts `text` as a Markdown quote at the caret. */
  function quote(text: string): void {
    apply([quoteEdit(selected(), text)]);
    editor.view.focus();
  }

  /** Puts `text` in place of the selection. */
  function insertText(text: string): void {
    const { from, to } = selected();
    replaceText(editor.view, from, to, text.replace(/\r\n?/g, "\n"));
  }

  const intake = { remote, attach: (a: Attachment) => addAttachment(a), error };

  // Drops anywhere in the view attach files; the editor leaves drops to this listener.
  const dragging = useFileDrop((dt) => {
    if (!takeTransfer(dt, intake)) {
      const text = dt.getData("text/plain");
      if (text) insertText(text);
    }
    editor.view.focus();
  });

  function onPaste(e: ClipboardEvent): boolean {
    const dt = e.clipboardData;
    if (!dt) return false;
    // A message copied from the chat brings its images back as tokens, not as the single PNG beside it.
    if (pasteMessage(dt)) return true;
    // Files (e.g. screenshots) become attachments.
    if (Array.from(dt.items).some((it) => it.kind === "file") && takeTransfer(dt, intake)) return true;
    // Copies from the composer keep their tokens; anything else goes in as the Markdown it is.
    if (dt.getData("text/html").includes("data-pm-slice")) return false;
    const text = dt.getData("text/plain");
    if (!text) return false;
    insertText(text);
    return true;
  }

  /** Pastes a message copied from the chat with its images. True when the clipboard held one. */
  function pasteMessage(dt: DataTransfer): boolean {
    const tab = activeRef.current;
    const images = copiedImages(dt.getData("text/html"));
    const text = dt.getData("text/plain").replace(/\r\n?/g, "\n");
    if (tab === undefined || !images?.length || !text) return false;
    const tokens = drafts.inlineOf(tab);
    pruneTokens(tokens, tokensIn(editor.state.doc));
    const pasted = pastedContent(text, images, (token) => tokens.has(token));
    for (const { token, attachment } of pasted.inline) tokens.set(token, attachment);
    const { from, to } = selected();
    replaceText(editor.view, from, to, pasted.text, tokenInfos(new Map(pasted.inline.map((x) => [x.token, x.attachment]))));
    return true;
  }

  /** The image token at `target`. */
  function imageTokenAt(target: EventTarget): { src: string; name: string; token: string; rect: DOMRect } | undefined {
    const mark = target instanceof Element ? target.closest<HTMLElement>("mark.token.image") : null;
    if (!mark || active === undefined) return undefined;
    const token = mark.dataset.token!;
    const a = drafts.inlineOf(active).get(token);
    const src = a && imageSrc(a);
    return a && src ? { src, name: a.name, token, rect: mark.getBoundingClientRect() } : undefined;
  }

  function onKeyDown(e: KeyboardEvent): boolean {
    if (suggest.onKey(e)) return true;
    if (e.isComposing) return false;
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      submit(true);
      return true;
    }
    if (e.key === "Enter" || (e.key === "ArrowDown" && !e.shiftKey && !e.altKey)) {
      const edits = codeKey(selected(), e.key, e.shiftKey);
      if (edits) {
        apply(edits);
        return true;
      }
    }
    if (e.key === "Enter" && e.shiftKey) {
      const edit = continueList(selected());
      if (edit) apply([edit]);
      else insertText("\n");
      return true;
    }
    if (e.key === "Enter") {
      submit(false);
      return true;
    }
    if (e.key === "Escape" && editing !== undefined && active !== undefined) {
      drafts.endEdit(active);
      return true;
    }
    return false;
  }

  handlers.current = {
    update: () => {
      drafts.saveDraft(textOf(editor.state.doc));
      suggest.refresh();
    },
    select: suggest.refresh,
    blur: suggest.close,
    keyDown: onKeyDown,
    paste: onPaste,
  };

  /** The composer content in order; undefined when there is nothing to send. */
  function content(tab: number): PromptPart[] | undefined {
    const text = textOf(editor.state.doc);
    const tokens = [...drafts.inlineOf(tab)].map(([token, a]) => ({ ...a, token }));
    const parts: PromptPart[] = [...splitTokens(text, tokens), ...attachments];
    return parts.every((p) => typeof p === "string" && !p.trim()) ? undefined : parts;
  }

  /** Offers the composer content to several agents; the host puts it back if that doesn't happen. */
  function sendToSeveral(): void {
    if (active === undefined) return;
    const parts = content(active);
    if (!parts) return;
    post({ type: "bestOf", tab: active, parts });
    drafts.clear(active);
  }

  /** Sends the composer content; while the agent works it is queued, unless `now`. An edit replaces its message. */
  function submit(now: boolean): void {
    if (active === undefined) return;
    const parts = content(active);
    if (!parts) return;
    post({ type: "send", tab: active, parts, now: now || undefined, rewind: editing });
    if (editing !== undefined) {
      drafts.endEdit(active);
      return;
    }
    drafts.clear(active);
  }

  const element: ReactNode = (
    <form
      id="composer"
      hidden={hidden}
      data-busy={busy || undefined}
      onSubmit={(e) => {
        e.preventDefault();
        submit(false);
      }}
    >
      {suggest.suggestions.length > 0 && <SuggestionList suggestions={suggest.suggestions} shown={suggest.shown} select={suggest.select} pick={suggest.pick} />}
      {active !== undefined && queue.length > 0 && <QueuedMessages tab={active} queue={queue} />}
      {active !== undefined && editing !== undefined && <EditingBar onCancel={() => drafts.endEdit(active)} />}
      <AttachmentChips
        attachments={attachments}
        onChange={(change) => update(active, (s) => ({ ...s, attachments: change(s.attachments) }))}
        setPreview={setPreview}
      />
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
              drafts.inlineOf(tab).set(hit.token, b);
              drafts.saveShown(tab);
            },
          });
        }}
      >
        <EditorContent editor={editor} />
      </div>
      <div id="actions">
        <AgentPanel tab={tabs.find((x) => x.id === active)} choices={agents} summary={quickConfig}>
          {agentConfig}
        </AgentPanel>
        <FolderSelect tab={tabs.find((x) => x.id === active)} folders={folders} />
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
          type="button"
          id="best-of"
          className="icon-btn"
          title={t("bestOf.send")}
          aria-label={t("bestOf.send")}
          hidden={agents.agents.length < 2 || editing !== undefined}
          onClick={sendToSeveral}
        >
          <Icon svg={splitIcon} />
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

  return {
    element,
    dragging,
    addAttachment,
    write,
    quote,
    seed: drafts.seed,
    setSearchResults: suggest.setSearchResults,
    setSkills: suggest.setSkills,
    focus: () => editor.view.focus(),
    load: drafts.load,
    endEdit: drafts.endEdit,
  };
}
