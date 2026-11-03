// @vitest-environment happy-dom
import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { DoctorState } from "../src/doctor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const posted: Array<unknown> = [];
(globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi = () => ({
  postMessage: (message: unknown) => void posted.push(message),
  getState: () => undefined,
  setState: () => {},
});
const { DoctorTab } = await import("../src/ui/settings/doctor");

describe("DoctorTab", () => {
  let container: HTMLElement;
  let root: Root;
  const draw = (doctor: DoctorState) => act(() => root.render(createElement(DoctorTab, { doctor })));
  const buttons = () => [...container.querySelectorAll("button")];
  const summary = () => container.querySelector(".doctor-summary")?.textContent;
  const click = (label: string) => act(() => buttons().find((button) => button.textContent?.endsWith(label))!.click());

  beforeEach(() => {
    posted.length = 0;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("offers a first run before anything is checked", () => {
    draw({ rows: [], running: false });
    assert.strictEqual(summary(), "doctor.idle");
    assert.lengthOf(container.querySelectorAll(".doctor-row"), 0);
    click("doctor.run");
    assert.deepStrictEqual(posted, [{ type: "doctorRun" }]);
  });

  it("shows rows by group, what is still running, and a way to stop", () => {
    draw({
      rows: [
        { id: "claude", group: "agents", label: "Claude" },
        { id: "node", group: "tools", label: "Node.js", result: { status: "ok", description: "v24.0.0" } },
      ],
      running: true,
    });
    assert.deepStrictEqual([...container.querySelectorAll("h3")].map((h) => h.textContent), ["doctor.group.tools", "doctor.group.agents"]);
    assert.deepStrictEqual([...container.querySelectorAll(".doctor-row")].map((row) => row.className), ["doctor-row ok", "doctor-row pending"]);
    assert.include(container.querySelector(".doctor-version")?.textContent, "v24.0.0");
    assert.strictEqual(summary(), "doctor.checking");
    click("doctor.stop");
    assert.deepStrictEqual(posted, [{ type: "doctorStop" }]);
  });

  it("counts what needs a look, and applies a row's fix", () => {
    draw({
      rows: [
        { id: "node", group: "tools", label: "Node.js", result: { status: "ok" } },
        { id: "uv", group: "tools", label: "uv", result: { status: "warning", detail: "Not found.", fix: { type: "open", url: "https://a" } } },
        { id: "agent:claude", group: "agents", label: "Claude", result: { status: "error", detail: "Login required.", fix: { type: "login", agentId: "claude" } } },
      ],
      running: false,
    });
    assert.strictEqual(summary(), "doctor.problems");
    click("doctor.fix.login");
    assert.deepStrictEqual(posted, [{ type: "doctorFix", id: "agent:claude" }]);
    assert.isDefined(buttons().find((button) => button.textContent === "doctor.fix.open"));
    assert.isDefined(buttons().find((button) => button.textContent?.endsWith("doctor.runAgain")));
  });

  it("says when everything is fine, and marks checks a stop left out", () => {
    draw({ rows: [{ id: "git", group: "tools", label: "git", result: { status: "ok" } }], running: false });
    assert.strictEqual(summary(), "doctor.allGood");
    draw({
      rows: [
        { id: "git", group: "tools", label: "git", result: { status: "ok" } },
        { id: "claude", group: "agents", label: "Claude" },
      ],
      running: false,
    });
    assert.strictEqual(summary(), "doctor.status.skipped");
    assert.exists(container.querySelector(".doctor-row.skipped"));
  });
});
