// @vitest-environment happy-dom
import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const posted: Array<unknown> = [];
(globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi = () => ({
  postMessage: (message: unknown) => void posted.push(message),
  getState: () => undefined,
  setState: () => {},
});
const { ChatSettings } = await import("../src/ui/chat/chatSettings");
const { placeSubMenu } = await import("../src/ui/chat/popupMenu");

describe("placeSubMenu", () => {
  const rect = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom }) as DOMRect;
  const viewport = (width: number, height: number) => {
    window.innerWidth = width;
    window.innerHeight = height;
  };
  const row = rect(50, 300, 250, 330);
  const menu = rect(40, 295, 260, 420);

  it("goes beside the menu when a side has room", () => {
    viewport(1000, 800);
    assert.deepStrictEqual(placeSubMenu(row, menu, 280, 200), { left: 264, top: 295, opens: "right" });
    assert.deepStrictEqual(placeSubMenu(rect(650, 300, 850, 330), rect(640, 295, 860, 420), 280, 200), {
      left: 356,
      top: 295,
      opens: "left",
    });
  });

  it("goes above the menu in a narrow view, without covering it", () => {
    viewport(360, 800);
    assert.deepStrictEqual(placeSubMenu(row, menu, 280, 200), { left: 40, top: 91, opens: "up" });
  });

  it("lines up with the menu's right edge when its left edge would push it out of the view", () => {
    viewport(360, 800);
    assert.deepStrictEqual(placeSubMenu(row, rect(150, 295, 340, 420), 280, 200), { left: 60, top: 91, opens: "up" });
  });

  it("goes below the menu when there is no room above", () => {
    viewport(360, 800);
    assert.deepStrictEqual(placeSubMenu(row, rect(40, 100, 260, 220), 280, 200), { left: 40, top: 224, opens: "down" });
  });

  it("covers the menu only when no side has room, and stays in the viewport", () => {
    viewport(360, 400);
    assert.deepStrictEqual(placeSubMenu(row, menu, 400, 390), { left: 4, top: 6, opens: "right" });
  });
});

describe("ChatSettings", () => {
  let root: Root;
  const toggle = () => document.querySelector<HTMLElement>("#tracing")!;
  const render = (tracing: boolean) =>
    act(() =>
      root.render(
        createElement(ChatSettings, {
          followAgent: false,
          autoScroll: true,
          showChanges: true,
          showRestore: false,
          tracing,
        }),
      ),
    );
  const open = (tracing: boolean) => {
    render(tracing);
    act(() => void document.querySelector<HTMLElement>("#chat-settings > button")!.click());
  };

  beforeEach(() => {
    posted.length = 0;
    document.body.innerHTML = '<div id="root"></div>';
    root = createRoot(document.getElementById("root")!);
  });

  afterEach(() => act(() => root.unmount()));

  const gear = () => document.querySelector<HTMLElement>("#chat-settings > button")!;
  const trigger = () => document.querySelector<HTMLElement>("#chat-settings-menu .submenu-trigger")!;
  const submenu = () => document.querySelector<HTMLElement>("#chat-settings-menu .submenu");
  const hover = (el: Element) => act(() => void el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
  const mouseClick = (el: Element) =>
    act(() => void el.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })));
  const keyClick = (el: Element) =>
    act(() => void el.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 })));

  it("gives every row of the menu and of the General sub-menu an icon", () => {
    open(false);
    hover(trigger());
    const rows = document.querySelectorAll(
      "#chat-settings-menu > button, #chat-settings-menu .submenu-trigger, #chat-settings-menu .submenu > button",
    );
    assert.strictEqual(rows.length, 7);
    for (const row of rows) assert.isNotNull(row.querySelector(":scope .svg-icon"), row.textContent ?? "");
  });

  it("opens the General settings on hover, and a click on the row keeps them open", () => {
    open(false);
    assert.isNull(submenu());
    hover(trigger());
    assert.isNotNull(submenu());
    mouseClick(trigger());
    assert.isNotNull(submenu());
  });

  it("opens the General settings on a click without a hover, and a key closes them", () => {
    open(false);
    mouseClick(trigger());
    assert.isNotNull(submenu());
    keyClick(trigger());
    assert.isNull(submenu());
  });

  it("offers every General setting, and stays open while they change", () => {
    open(false);
    hover(trigger());
    const toggles = [...submenu()!.querySelectorAll<HTMLElement>("[role=menuitemcheckbox]")];
    assert.deepStrictEqual(
      toggles.map((el) => [el.id, el.getAttribute("aria-checked")]),
      [
        ["follow", "false"],
        ["auto-scroll", "true"],
        ["show-changes", "true"],
        ["show-restore", "false"],
      ],
    );
    for (const el of toggles) act(() => el.click());
    assert.deepStrictEqual(posted, [
      { type: "setFollowAgent", enabled: true },
      { type: "setAutoScroll", enabled: false },
      { type: "setShowChanges", enabled: false },
      { type: "setShowRestore", enabled: true },
    ]);
    assert.isNotNull(submenu());
  });

  it("leaves the language to the settings page", () => {
    open(false);
    hover(trigger());
    assert.isEmpty(submenu()!.querySelectorAll("[role=menuitemradio]"));
  });

  it("drops the gear's tooltip while its menu is open, and a click after the hover keeps it", () => {
    render(false);
    assert.isTrue(gear().hasAttribute("title"));
    hover(gear());
    assert.isFalse(gear().hasAttribute("title"));
    mouseClick(gear());
    assert.isNotNull(document.querySelector("#chat-settings-menu"));
  });

  it("turns tracing on", () => {
    open(false);
    assert.strictEqual(toggle().getAttribute("aria-checked"), "false");
    act(() => toggle().click());
    assert.deepStrictEqual(posted, [{ type: "setTracing", enabled: true }]);
  });

  it("turns tracing off", () => {
    open(true);
    assert.strictEqual(toggle().getAttribute("aria-checked"), "true");
    act(() => toggle().click());
    assert.deepStrictEqual(posted, [{ type: "setTracing", enabled: false }]);
  });
});
