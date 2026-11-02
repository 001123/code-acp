import type { Editor } from "@tiptap/react";
import { useEffect, useLayoutEffect, useRef, type MutableRefObject } from "react";
import type { Attachment, Draft, PromptPart, TabInfo } from "../../chat/protocol";
import { appendContent, contentOf, tokenInfos, type Content } from "./composerContent";
import { DraftSender } from "./draftSender";
import { resetText, textOf } from "./editor";
import { post } from "./post";
import type { TabState } from "./tabs";

/** The composer content of every tab: the active tab's is in the editor, and all of it survives reloads as drafts. */
export function useComposerDrafts({
  editor,
  active,
  activeRef,
  tabs,
  states,
  attachments,
  update,
}: {
  editor: Editor;
  active: number | undefined;
  activeRef: MutableRefObject<number | undefined>;
  tabs: TabInfo[];
  states: Record<number, TabState>;
  attachments: Attachment[];
  update: (tab: number | undefined, f: (s: TabState) => TabState) => void;
}) {
  /** Unsent text per tab; the editor holds the active tab's. */
  const drafts = useRef(new Map<number, string>());
  const shownDraft = useRef<number>(undefined);
  const sender = useRef(new DraftSender(post));
  /** Tabs whose saved draft was taken; later "tabs" messages don't overwrite what was typed since. */
  const seeded = useRef(new Set<number>());
  /** Per tab editing a sent message, what its composer held before; it comes back once the edit is sent or cancelled. */
  const beforeEdit = useRef(new Map<number, Content>());
  /** Files and snippets per tab, by the token that stands for them in the composer text. */
  const inline = useRef(new Map<number, Map<string, Attachment>>());
  const statesRef = useRef(states);
  statesRef.current = states;

  function inlineOf(tab: number): Map<string, Attachment> {
    let map = inline.current.get(tab);
    if (!map) inline.current.set(tab, (map = new Map()));
    return map;
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
      // Shown when the tab is next selected; saved now, as the window may reload before that.
      drafts.current.set(tab, content.text);
      saveContent(tab, content);
      return;
    }
    resetText(editor.view, content.text, tokenInfos(content.inline));
    editor.view.focus();
    saveDraft(content.text);
  }

  /**
   * Puts a message back in the composer of `tab`: a queued or unsent one after what is there, or a sent one (with
   * `rewind`, its turn) in place of it until the edit is sent or cancelled.
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

  /** Empties the composer of the active `tab`, after its content was sent. */
  function clear(tab: number): void {
    resetText(editor.view, "", []);
    saveDraft("");
    update(tab, (s) => ({ ...s, attachments: [] }));
    inline.current.delete(tab);
  }

  /** Sends the active tab's composer content to the extension, at most every 300 ms. */
  function saveDraft(text: string): void {
    const tab = activeRef.current;
    if (tab === undefined) return;
    saveContent(tab, { text, inline: inlineOf(tab), attachments: statesRef.current[tab]?.attachments ?? [] });
  }

  function saveContent(tab: number, { text, inline, attachments }: Content): void {
    const draft: Draft = {
      text,
      inline: [...inline].filter(([token]) => text.includes(token)).map(([token, attachment]) => ({ token, attachment })),
      attachments,
    };
    sender.current.save(tab, draft);
  }

  /** Saves what the editor holds, if it still shows `tab`. */
  function saveShown(tab: number): void {
    if (tab === shownDraft.current) saveDraft(textOf(editor.state.doc));
  }

  // Swaps the composer text when another tab becomes active.
  useLayoutEffect(() => {
    if (shownDraft.current === active) return;
    if (shownDraft.current !== undefined) drafts.current.set(shownDraft.current, textOf(editor.state.doc));
    const open = (id: number) => tabs.some((x) => x.id === id);
    for (const perTab of [drafts.current, inline.current, beforeEdit.current]) {
      for (const id of perTab.keys()) if (!open(id)) perTab.delete(id);
    }
    sender.current.prune(open);
    const text = (active !== undefined && drafts.current.get(active)) || "";
    resetText(editor.view, text, active !== undefined ? tokenInfos(inlineOf(active)) : []);
    shownDraft.current = active;
    saveDraft(text);
    editor.view.focus();
  }, [active]);

  // Attachments outside the text change without an edit.
  useEffect(() => {
    saveDraft(textOf(editor.state.doc));
  }, [attachments]);

  return { inlineOf, seed, load, endEdit, clear, saveDraft, saveShown };
}
