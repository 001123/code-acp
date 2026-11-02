// @vitest-environment happy-dom
import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { vi } from "vitest";
import { ErrorBoundary } from "../src/ui/errorBoundary";
import { mount } from "../src/ui/mount";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Item({ text }: { text: string }) {
  if (text === "bad") throw new URIError("URI malformed");
  return createElement("p", null, text);
}

describe("ErrorBoundary", () => {
  let container: HTMLElement;
  let root: Root;
  const draw = (node: ReactNode) => act(() => root.render(node));
  const entry = (text: string) =>
    createElement(ErrorBoundary, { resetKeys: [text], fallback: (message) => `failed: ${message}`, children: createElement(Item, { text }) });

  beforeEach(() => {
    // React reports what a boundary caught.
    vi.spyOn(console, "error").mockImplementation(() => {});
    document.body.innerHTML = '<div id="root"></div>';
    container = document.getElementById("root")!;
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.restoreAllMocks();
  });

  it("shows the fallback and keeps the siblings of what failed", () => {
    draw(createElement("div", null, entry("good"), entry("bad")));
    assert.strictEqual(container.textContent, "goodfailed: URI malformed");
  });

  it("stays on the fallback while the keys are the same", () => {
    draw(entry("bad"));
    draw(entry("bad"));
    assert.strictEqual(container.textContent, "failed: URI malformed");
  });

  it("renders the children again when a key changes", () => {
    draw(entry("bad"));
    draw(entry("fixed"));
    assert.strictEqual(container.textContent, "fixed");
  });

  it("falls back when new keys bring the failure, and recovers from it", () => {
    draw(entry("good"));
    draw(entry("bad"));
    assert.strictEqual(container.textContent, "failed: URI malformed");
    draw(entry("good"));
    assert.strictEqual(container.textContent, "good");
  });
});

describe("mount", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the crash screen instead of a blank page, and reload renders the app again", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    document.body.innerHTML = '<div id="root"></div>';
    let text = "bad";
    const App = () => createElement(Item, { text });
    await act(async () => mount(createElement(App)));
    const container = document.getElementById("root")!;
    assert.include(container.textContent, "webview.crashed");
    text = "back";
    await act(async () => container.querySelector("button")!.click());
    assert.strictEqual(container.textContent, "back");
  });
});
