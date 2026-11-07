import { assert, describe, it } from "@effect/vitest";
import type * as vscode from "vscode";
import { ASKS, AskAgentActions } from "../src/askAgent";
import { AttachmentQueue } from "../src/chat/attachments";
import type { Attachment } from "../src/chat/protocol";

const actionsFor = (isEmpty: boolean) =>
  new AskAgentActions().provideCodeActions({} as vscode.TextDocument, { isEmpty } as vscode.Range);

describe("AskAgentActions", () => {
  it("offers every ask on a selection", () => {
    const actions = actionsFor(false);
    assert.deepStrictEqual(
      actions.map((a) => [a.title, a.command?.command]),
      [
        ["Explain with KD Code", "kdCode.explainSelection"],
        ["Refactor with KD Code", "kdCode.refactorSelection"],
        ["Write tests with KD Code", "kdCode.testSelection"],
      ],
    );
    assert.strictEqual(actions[0]!.kind?.value, "kdCode");
    assert.strictEqual(ASKS.length, actions.length);
  });

  it("offers nothing without a selection", () => {
    assert.deepStrictEqual(actionsFor(true), []);
  });
});

describe("AttachmentQueue", () => {
  const snippet: Attachment = { kind: "uri", uri: "file:///w/a.ts", name: "a.ts" };

  it("keeps attachments and prompts until the webview takes them", () => {
    const delivered: Array<[Attachment[], string | undefined]> = [];
    let ready = false;
    const queue = new AttachmentQueue((attachments, prompt) => {
      if (!ready) return false;
      delivered.push([[...attachments], prompt]);
      return true;
    });
    queue.add([snippet], "Explain.");
    queue.add([snippet], "Refactor.");
    assert.deepStrictEqual(delivered, []);
    ready = true;
    queue.flush();
    assert.deepStrictEqual(delivered, [[[snippet, snippet], "Explain.\n\nRefactor."]]);
    queue.add([snippet]);
    assert.deepStrictEqual(delivered[1], [[snippet], undefined]);
  });
});
