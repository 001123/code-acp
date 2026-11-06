// @vitest-environment happy-dom
import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest";
import type { Editor } from "@tiptap/core";
import { act, createElement, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { vi } from "vitest";
import type { Attachment, TabInfo } from "../src/chat/protocol";
import { useComposer } from "../src/ui/chat/composer";
import type { TabState } from "../src/ui/chat/tabs";

const { posted } = vi.hoisted(() => {
  (globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi = () => ({
    postMessage: () => {},
    getState: () => undefined,
    setState: () => {},
  });
  return { posted: [] as Array<Record<string, unknown>> };
});

vi.mock("../src/ui/chat/post", () => ({
  post: (message: Record<string, unknown>) => void posted.push(message),
  openFile: () => {},
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const tabs = [1, 2].map((id) => ({ id, pinned: false, cwd: "/w", canFork: false })) as TabInfo[];
const image: Attachment = { kind: "data", name: "shot.png", mimeType: "image/png", data: "AAAA" };
const snippet: Attachment = {
  kind: "snippet",
  uri: "file:///a.ts",
  name: "a.ts:1",
  languageId: "ts",
  startLine: 1,
  endLine: 1,
  text: "x",
};

describe("copying from the composer to another tab", () => {
  let root: Root;
  let composer: ReturnType<typeof useComposer>;
  let select: (tab: number) => void;

  function Chat() {
    const [active, setActive] = useState(1);
    const activeRef = useRef<number | undefined>(active);
    activeRef.current = active;
    select = setActive;
    const [states, setStates] = useState<Record<number, TabState>>({});
    composer = useComposer({
      active,
      activeRef,
      tabs,
      states,
      attachments: states[active]?.attachments ?? [],
      queue: [],
      editing: undefined,
      commands: [],
      busy: false,
      agents: { agents: [], activeId: undefined } as never,
      folders: [],
      remote: false,
      update: (tab, f) => {
        if (tab !== undefined)
          setStates((s) => ({ ...s, [tab]: f(s[tab] ?? ({ attachments: [] } as unknown as TabState)) }));
      },
      error: () => {},
      setPreview: () => {},
      setHover: () => {},
      usage: null,
      settings: null,
      agentConfig: undefined,
      quickConfig: null,
      config: [],
      hidden: false,
    });
    return composer.element;
  }

  const dom = () => document.querySelector<HTMLElement & { editor: Editor }>(".ProseMirror")!;

  /** Fires a clipboard event on the editor with `data`, which it writes to on a copy. */
  function clipboard(type: "copy" | "cut" | "paste", data: DataTransfer): void {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, { clipboardData: data });
    act(() => void dom().dispatchEvent(event));
  }

  function copyAll(type: "copy" | "cut" = "copy"): DataTransfer {
    const data = new DataTransfer();
    act(() => void dom().editor.commands.selectAll());
    clipboard(type, data);
    return data;
  }

  function send(): Array<Record<string, unknown> | string> {
    act(
      () =>
        void document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    return posted.filter((m) => m.type === "send").at(-1)!.parts as Array<Record<string, unknown> | string>;
  }

  beforeEach(() => {
    posted.length = 0;
    document.body.innerHTML = '<div id="root"></div>';
    root = createRoot(document.getElementById("root")!);
    act(() => root.render(createElement(Chat)));
  });

  afterEach(() => act(() => root.unmount()));

  it("takes an image along, so the new tab can send it", () => {
    act(() => composer.addAttachment(image));
    const data = copyAll();
    act(() => select(2));
    clipboard("paste", data);
    assert.deepStrictEqual(
      send().filter((p) => typeof p !== "string"),
      [{ ...image, token: "@shot.png" }],
    );
  });

  it("takes other attachments along", () => {
    act(() => composer.addAttachment(snippet));
    const data = copyAll();
    act(() => select(2));
    clipboard("paste", data);
    assert.deepStrictEqual(
      send().filter((p) => typeof p !== "string"),
      [{ ...snippet, token: "@a.ts:1" }],
    );
  });

  it("gives a copy in the same tab its own token", () => {
    act(() => composer.addAttachment(image));
    const data = copyAll();
    act(() => void dom().editor.commands.setTextSelection(dom().editor.state.doc.content.size - 1));
    clipboard("paste", data);
    assert.deepStrictEqual(
      send().flatMap((p) => (typeof p === "string" ? [] : [p.token])),
      ["@shot.png", "@shot.png (2)"],
    );
  });

  it("keeps a cut token when pasted back", () => {
    act(() => composer.addAttachment(image));
    const data = copyAll("cut");
    clipboard("paste", data);
    assert.deepStrictEqual(
      send().filter((p) => typeof p !== "string"),
      [{ ...image, token: "@shot.png" }],
    );
  });

  it("pastes tokens it has no attachment for as text, not as chips", () => {
    const data = new DataTransfer();
    data.setData("text/plain", "see @gone.png");
    data.setData(
      "text/html",
      '<p data-pm-slice="1 1 []">see <mark class="token image" data-token="@gone.png">@gone.png</mark></p>',
    );
    clipboard("paste", data);
    assert.isNull(dom().querySelector("mark"));
    assert.strictEqual(dom().textContent, "see @gone.png");
  });
});
