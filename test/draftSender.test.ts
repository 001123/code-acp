import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest";
import { vi } from "vitest";
import type { Attachment, Draft } from "../src/chat/protocol";
import { DraftSender, type DraftMessage } from "../src/ui/chat/draftSender";

const a: Attachment = { kind: "uri", uri: "file:///a.ts", name: "a.ts" };
const draft = (text: string, attachments: Attachment[] = []): Draft => ({ text, inline: [], attachments });

const sender = () => {
  const sent: DraftMessage[] = [];
  return { sent, drafts: new DraftSender((message) => sent.push(message), 300) };
};

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

describe("DraftSender", () => {
  it("sends the latest draft once typing pauses", () => {
    const { sent, drafts } = sender();
    drafts.save(1, draft("a"));
    vi.advanceTimersByTime(200);
    drafts.save(1, draft("ab"));
    vi.advanceTimersByTime(299);
    assert.deepStrictEqual(sent, []);
    vi.advanceTimersByTime(1);
    assert.deepStrictEqual(sent, [{ type: "draft", tab: 1, draft: draft("ab") }]);
  });

  it("sends only the text while the attachments stay the same", () => {
    const { sent, drafts } = sender();
    drafts.save(1, draft("a", [a]));
    drafts.flush();
    drafts.save(1, draft("ab", [a]));
    drafts.flush();
    assert.deepStrictEqual(sent, [
      { type: "draft", tab: 1, draft: draft("a", [a]) },
      { type: "draftText", tab: 1, text: "ab" },
    ]);
  });

  it("sends everything when the attachments change", () => {
    const { sent, drafts } = sender();
    drafts.save(1, draft("a", [a]));
    drafts.flush();
    drafts.save(1, draft("a"));
    drafts.flush();
    assert.deepStrictEqual(sent.map((m) => m.type), ["draft", "draft"]);
  });

  it("does not lose a tab's draft when another tab's comes next", () => {
    const { sent, drafts } = sender();
    drafts.save(1, draft("one"));
    drafts.save(2, draft("two"));
    assert.deepStrictEqual(sent, [{ type: "draft", tab: 1, draft: draft("one") }]);
    vi.advanceTimersByTime(300);
    assert.deepStrictEqual(sent.at(-1), { type: "draft", tab: 2, draft: draft("two") });
  });

  it("flushes nothing twice", () => {
    const { sent, drafts } = sender();
    drafts.save(1, draft("a"));
    drafts.flush();
    drafts.flush();
    vi.advanceTimersByTime(1000);
    assert.strictEqual(sent.length, 1);
  });

  it("sends a pruned tab's next draft in full", () => {
    const { sent, drafts } = sender();
    drafts.save(1, draft("a", [a]));
    drafts.flush();
    drafts.prune(() => false);
    drafts.save(1, draft("a", [a]));
    drafts.flush();
    assert.deepStrictEqual(sent.map((m) => m.type), ["draft", "draft"]);
  });
});
