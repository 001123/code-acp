import { assert, describe, it } from "@effect/vitest";
import type { Translate } from "../src/ui/l10n";
import { exportFileName } from "../src/chat/exportConversation";
import { conversationMarkdown } from "../src/ui/chat/exportMarkdown";
import type { Item } from "../src/ui/chat/transcript";

const t = ((key: string) => key) as Translate;
const info = { title: "My *chat*", agent: "Mock", date: "today" };

describe("conversationMarkdown", () => {
  it("is empty until someone said something", () => {
    assert.strictEqual(conversationMarkdown(t, [], info), "");
    assert.strictEqual(conversationMarkdown(t, [{ kind: "error", id: 1, text: { raw: "no agent" } }], info), "");
  });

  it("writes speakers once per turn, with tool calls as one compact list", () => {
    const items: Item[] = [
      { kind: "userMessage", id: 1, text: "Fix **it**", attachments: [{ name: "a.png" }, { name: "b.ts", token: "@b.ts" }] },
      { kind: "thought", id: 2, text: "Hmm" },
      {
        kind: "tool",
        id: 3,
        toolCallId: "t1",
        title: "Run `npm test`\n<now>",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "SECRET OUTPUT" } }],
        children: [{ kind: "tool", id: 4, toolCallId: "t2", title: "Read", status: "failed" }],
      },
      { kind: "tool", id: 5, toolCallId: "t3" },
      { kind: "plan", id: 6, entries: [{ content: "One", status: "completed", priority: "high" }, { content: "Two", status: "pending", priority: "low" }] },
      { kind: "assistant", id: 7, text: "Done\n\n```ts\nx\n```" },
      { kind: "notice", id: 8, text: { raw: "Cancelled" } },
      { kind: "error", id: 9, text: { raw: "line 1\nline 2" } },
      { kind: "trace", id: 10, trace: {} as never },
      { kind: "permission", id: 11, requestId: 1, toolCall: { toolCallId: "t1" }, options: [], done: true },
      { kind: "user", id: 12, text: "Again" },
    ];
    assert.strictEqual(
      conversationMarkdown(t, items, info),
      [
        "# My \\*chat\\*",
        "Mock · today",
        "## export.user",
        "Fix **it**\n\nexport.attachments: a.png",
        "## export.assistant",
        "<details>\n<summary>chat.thought</summary>\n\nHmm\n\n</details>",
        "- ✓ Run \\`npm test\\` \\<now\\>\n  - ✗ Read\n- • export.tool",
        "**chat.plan**\n\n- [x] One\n- [ ] Two",
        "Done\n\n```ts\nx\n```",
        "_Cancelled_",
        "> line 1\n> line 2",
        "## export.user",
        "Again",
      ].join("\n\n") + "\n",
    );
  });

  it("keeps a compaction's summary collapsed, and only its line without one", () => {
    const items: Item[] = [
      { kind: "assistant", id: 1, text: "Hi" },
      { kind: "compaction", id: 2, compactionId: "a", status: "completed", summary: "Short" },
      { kind: "compaction", id: 3, compactionId: "b", status: "in_progress", summary: "" },
    ];
    const markdown = conversationMarkdown(t, items, { title: "x", date: "d" });
    assert.include(markdown, "<summary>chat.compaction.completed</summary>\n\nShort");
    assert.include(markdown, "_chat.compaction.inProgress_");
  });
});

describe("exportFileName", () => {
  it("leaves out what file systems refuse", () => {
    assert.strictEqual(exportFileName(' a/b: "c"?\n '), "a b c.md");
    assert.strictEqual(exportFileName("../secret"), "secret.md");
    assert.strictEqual(exportFileName("Tìm kiếm"), "Tìm kiếm.md");
  });

  it("falls back when nothing is left, and stays short", () => {
    assert.strictEqual(exportFileName(undefined), "conversation.md");
    assert.strictEqual(exportFileName("///"), "conversation.md");
    assert.strictEqual(exportFileName("x".repeat(200)), `${"x".repeat(80)}.md`);
  });
});
