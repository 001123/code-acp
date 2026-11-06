// @vitest-environment happy-dom
import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest";
import { EditorContent, useEditor } from "@tiptap/react";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { vi } from "vitest";
import type { Attachment, Draft, TabInfo } from "../src/chat/protocol";
import { useComposerDrafts } from "../src/ui/chat/composerDrafts";
import { composerExtensions } from "../src/ui/chat/editor";
import type { TabState } from "../src/ui/chat/tabs";

const { posted } = vi.hoisted(() => ({ posted: [] as Array<Record<string, unknown>> }));

vi.mock("../src/ui/chat/post", () => ({ post: (message: Record<string, unknown>) => void posted.push(message) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const tabs = [1, 2].map((id) => ({ id, pinned: false, cwd: "/w", canFork: false })) as TabInfo[];
const file: Attachment = { kind: "uri", uri: "file:///a.ts", name: "a.ts" };
const other: Attachment = { kind: "uri", uri: "file:///b.ts", name: "b.ts" };

describe("useComposerDrafts", () => {
  let root: Root;
  let drafts: ReturnType<typeof useComposerDrafts>;

  /** The composer with tab 1 active. */
  function Composer() {
    const editor = useEditor({ extensions: composerExtensions(() => ""), immediatelyRender: true, injectCSS: false });
    const [states, setStates] = useState<Record<number, TabState>>({});
    drafts = useComposerDrafts({
      editor,
      active: 1,
      activeRef: { current: 1 },
      tabs,
      states,
      attachments: [],
      update: (tab, f) => {
        if (tab !== undefined) setStates((s) => ({ ...s, [tab]: f(s[tab] ?? ({} as TabState)) }));
      },
    });
    return createElement(EditorContent, { editor });
  }

  const lastDraft = (tab: number) => {
    act(() => void vi.advanceTimersByTime(300));
    return posted.filter((message) => message.type === "draft" && message.tab === tab).at(-1)?.draft as
      Draft | undefined;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    posted.length = 0;
    document.body.innerHTML = '<div id="root"></div>';
    root = createRoot(document.getElementById("root")!);
    act(() => root.render(createElement(Composer)));
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
  });

  it("saves a message put back in a tab that isn't shown", () => {
    act(() => drafts.load(2, ["see ", { ...file, token: "@a.ts" }, other]));
    assert.deepStrictEqual(lastDraft(2), {
      text: "see @a.ts",
      inline: [{ token: "@a.ts", attachment: file }],
      attachments: [other],
    });
  });

  it("saves it after what the tab held", () => {
    act(() =>
      drafts.seed([
        {
          ...tabs[1]!,
          draft: { text: "typed @a.ts", inline: [{ token: "@a.ts", attachment: file }], attachments: [] },
        },
      ]),
    );
    act(() => drafts.load(2, ["message"]));
    assert.deepStrictEqual(lastDraft(2), {
      text: "typed @a.ts\n\nmessage",
      inline: [{ token: "@a.ts", attachment: file }],
      attachments: [],
    });
  });
});
