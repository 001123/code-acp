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
const { UsageMeter } = await import("../src/ui/chat/usageMeter");

describe("UsageMeter", () => {
  let container: HTMLElement;
  let root: Root;
  const draw = (props: { busy?: boolean; onCompact?: () => void }) =>
    act(() =>
      root.render(
        createElement(UsageMeter, {
          usage: { used: 10, size: 100 },
          compactAt: undefined,
          totals: undefined,
          busy: props.busy ?? false,
          onCompact: props.onCompact,
        }),
      ),
    );
  const button = () => container.querySelector("button");

  beforeEach(() => {
    posted.length = 0;
    document.body.innerHTML = '<div id="root"></div>';
    container = document.getElementById("root")!;
    root = createRoot(container);
  });

  afterEach(() => act(() => root.unmount()));

  it("offers no compact button when the agent has no such command", () => {
    draw({});
    assert.isNull(button());
  });

  it("compacts on click, without opening the usage summary", () => {
    let compacted = 0;
    draw({ onCompact: () => compacted++ });
    act(() => button()!.click());
    assert.strictEqual(compacted, 1);
    assert.deepStrictEqual(posted, []);
  });

  it("does not submit the composer form around it", () => {
    draw({ onCompact: () => {} });
    assert.strictEqual(button()!.getAttribute("type"), "button");
  });

  it("disables the button during a turn, and a click beside it opens nothing", () => {
    draw({ busy: true, onCompact: () => {} });
    assert.isTrue(button()!.disabled);
    act(() => (container.querySelector(".usage-actions") as HTMLElement).click());
    assert.deepStrictEqual(posted, []);
  });

  it("opens the usage summary from the ring and the panel", () => {
    draw({ onCompact: () => {} });
    const ring = container.querySelector("#usage-ring") as HTMLElement;
    act(() => ring.click());
    act(() => void ring.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    act(() => (container.querySelector(".usage-hint") as HTMLElement).click());
    assert.deepStrictEqual(posted, [{ type: "showUsage" }, { type: "showUsage" }, { type: "showUsage" }]);
  });
});
