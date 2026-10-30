import type * as acp from "@agentclientprotocol/sdk";
import { NodeFileSystem } from "@effect/platform-node-shared";
import { assert, beforeEach, describe, it } from "@effect/vitest";
import { Effect, Fiber, FileSystem, Schema } from "effect";
import * as os from "node:os";
import * as path from "node:path";
import { AgentRequestError, type AcpAgent } from "../src/acpClient";
import { DraftStore, type DraftHolder } from "../src/chat/drafts";
import { canReopen, HistoryRequests, listHistory } from "../src/chat/history";
import { CANCELLED, Permissions } from "../src/chat/permissions";
import type { Attachment } from "../src/chat/protocol";
import { replayedParts } from "../src/chat/replay";
import { messageText, resetConversation, SavedTabs, TabList } from "../src/chat/tabs";
import { matchesSession } from "../src/ui/chat/search";
import { transcript, EMPTY, fileLinkTokens, type Action } from "../src/ui/chat/transcript";
import { cwdForNewTab, defaultCwd, folderOf, isWorkspaceFolder, resolvePath, workspaceFolders } from "../src/workspace";
import { __test, Uri, window, workspace } from "./stubs/vscode";

const folders = (...paths: string[]) => {
  workspace.workspaceFolders = paths.map((p) => ({ name: path.basename(p), uri: Uri.file(p) }));
};

beforeEach(() => __test.reset());

describe("workspace", () => {
  it("lists only folders on disk", () => {
    workspace.workspaceFolders = [
      { name: "a", uri: Uri.file("/w/a") },
      { name: "remote", uri: Uri.from({ scheme: "vscode-vfs", path: "/github/repo" }) },
    ];
    assert.deepStrictEqual(workspaceFolders(), [{ name: "a", path: "/w/a" }]);
    assert.strictEqual(defaultCwd(), "/w/a");
  });

  it("falls back to the home folder without a workspace", () => {
    assert.strictEqual(defaultCwd(), os.homedir());
  });

  it("finds the innermost folder holding a file", () => {
    folders("/w/app", "/w/app/packages/lib", "/w/other");
    assert.strictEqual(folderOf("/w/app/packages/lib/src/x.ts")?.path, "/w/app/packages/lib");
    assert.strictEqual(folderOf("/w/app/README.md")?.path, "/w/app");
    assert.strictEqual(folderOf("/w/other")?.path, "/w/other");
    assert.isUndefined(folderOf("/w/application/x.ts"));
    assert.strictEqual(folderOf("/w/app/..cache/x")?.path, "/w/app");
    assert.isTrue(isWorkspaceFolder("/w/other"));
    assert.isFalse(isWorkspaceFolder("/w/app/packages"));
  });

  it("picks a new tab's folder from the active editor, else the given one, else the first", () => {
    folders("/w/a", "/w/b");
    assert.strictEqual(cwdForNewTab(undefined), "/w/a");
    assert.strictEqual(cwdForNewTab("/w/b"), "/w/b");
    assert.strictEqual(cwdForNewTab("/gone"), "/w/a");
    assert.strictEqual(cwdForNewTab("/w/b/packages/x"), "/w/b");
    window.activeTextEditor = { document: { uri: Uri.file("/w/b/src/main.ts") } };
    assert.strictEqual(cwdForNewTab("/w/a"), "/w/b");
  });

  it("resolves agent paths against the tab's folder", () => {
    assert.strictEqual(resolvePath("src/x.ts", "/w/b"), "/w/b/src/x.ts");
    assert.strictEqual(resolvePath("/abs/x.ts", "/w/b"), "/abs/x.ts");
    assert.strictEqual(resolvePath("~/notes.md", "/w/b"), path.join(os.homedir(), "notes.md"));
  });
});

describe("TabList", () => {
  const saved = {
    active: 1,
    tabs: [
      { pinned: true, cwd: "/w/a", agentId: "claude" },
      {
        title: "Fix bug",
        createdAt: 1,
        sessionId: "s1",
        cwd: "/w/b",
        agentId: "claude",
        usage: { used: 10, size: 100 },
        draft: { text: "hi", inline: [], attachments: [{ kind: "uri", uri: "file:///w/b/x", name: "x" }] },
      },
    ],
  };

  it("restores saved tabs, their sessions to reopen and their folders", () => {
    const list = new TabList(saved, () => "/default");
    assert.strictEqual(list.length, 2);
    assert.strictEqual(list.active, list.at(1));
    const [first, second] = list.all;
    assert.isTrue(first!.pinned);
    assert.strictEqual(first!.cwd, "/w/a");
    assert.isUndefined(first!.reopen);
    assert.deepStrictEqual(second!.reopen, { sessionId: "s1", cwd: "/w/b", agentId: "claude" });
    assert.strictEqual(second!.cwd, "/w/b");
    assert.isTrue(second!.used);
    assert.strictEqual(second!.savedDraft?.text, "hi");
  });

  it("saves what it restored", () => {
    const list = new TabList(saved, () => "/default");
    const again = Schema.decodeSync(SavedTabs)(list.saved);
    assert.strictEqual(again.active, 1);
    assert.deepStrictEqual(
      again.tabs.map((t) => [t.sessionId, t.cwd, t.pinned]),
      [
        [undefined, "/w/a", true],
        ["s1", "/w/b", false],
      ],
    );
    assert.deepStrictEqual(again.tabs[1]!.usage, { used: 10, size: 100 });
  });

  it("starts with one tab in the default folder when the saved state is invalid", () => {
    for (const bad of [undefined, null, "tabs", { active: "0", tabs: [] }, { active: 0, tabs: [{ pinned: "yes" }] }]) {
      const list = new TabList(bad, () => "/default");
      assert.strictEqual(list.length, 1);
      assert.strictEqual(list.active.cwd, "/default");
    }
  });

  it("rejects saved drafts with unknown attachment kinds", () => {
    const bad = { active: 0, tabs: [{ draft: { text: "", inline: [], attachments: [{ kind: "data", data: "" }] } }] };
    assert.isTrue(Schema.decodeUnknownOption(SavedTabs)(bad)._tag === "None");
  });

  it("keeps pinned tabs before the others when moving and pinning", () => {
    const list = new TabList(undefined, () => "/d");
    const [a, b, c] = [list.active, list.add("/d"), list.add("/d")];
    assert.isTrue(list.pin(c, true));
    assert.deepStrictEqual(list.all.map((t) => t.id), [c.id, a.id, b.id]);
    assert.isFalse(list.pin(c, true));
    // An unpinned tab can't move into the pinned group.
    list.move(b, 0);
    assert.deepStrictEqual(list.all.map((t) => t.id), [c.id, b.id, a.id]);
    list.pin(c, false);
    assert.deepStrictEqual(list.all.map((t) => t.id), [c.id, b.id, a.id]);
    assert.strictEqual(list.remove(b), 1);
    assert.strictEqual(list.remove(b), -1);
    assert.isFalse(list.has(b));
  });

  it("shows the user's name over the title, and keeps it across a reload", () => {
    const list = new TabList(undefined, () => "/d");
    const tab = list.active;
    tab.title = "From the agent";
    assert.isTrue(list.rename(tab, "  Mine "));
    assert.isFalse(list.rename(tab, "Mine"));
    tab.title = "Newer from the agent";
    assert.strictEqual(list.info[0]!.title, "Mine");
    const restored = new TabList(list.saved, () => "/d");
    assert.strictEqual(restored.info[0]!.title, "Mine");
    // An empty name shows the title again.
    assert.isTrue(list.rename(tab, " "));
    assert.strictEqual(list.info[0]!.title, "Newer from the agent");
    assert.isFalse(list.rename(tab, ""));
  });
});

describe("history search", () => {
  const session = { sessionId: "s", cwd: "/work/code-acp", title: "Tìm kiếm trong lịch sử" };

  it("matches every word, ignoring case and diacritics", () => {
    assert.isTrue(matchesSession(session, ""));
    assert.isTrue(matchesSession(session, "tim LICH"));
    assert.isTrue(matchesSession(session, "lịch code-acp"));
    assert.isFalse(matchesSession(session, "tim tab"));
    assert.isTrue(matchesSession({ sessionId: "d", cwd: "/w", title: "Đổi tên" }, "doi"));
  });
});

describe("Permissions", () => {
  const request = { sessionId: "s", toolCall: { toolCallId: "t" }, options: [] } as unknown as acp.RequestPermissionRequest;

  const make = () => {
    const shown: number[] = [];
    const done: number[] = [];
    const permissions = new Permissions<string>({ shown: (_, id) => void shown.push(id), done: (_, id) => void done.push(id) });
    return { permissions, shown, done };
  };
  // The agent's own signals come from outside Effect.
  const never = new AbortController().signal;

  it.effect("answers with the option the user picked", () =>
    Effect.gen(function* () {
      const { permissions, shown, done } = make();
      const fiber = yield* Effect.forkChild(permissions.request("tab", request, never));
      yield* Effect.yieldNow;
      assert.deepStrictEqual(shown, [1]);
      permissions.answer(1, "allow");
      assert.deepStrictEqual(yield* Fiber.join(fiber), { outcome: { outcome: "selected", optionId: "allow" } });
      assert.deepStrictEqual(done, [1]);
      // A second answer to the same request is ignored.
      permissions.answer(1, "deny");
      assert.deepStrictEqual(done, [1]);
    }),
  );

  it.effect("cancels the requests of one tab, and when the agent aborts", () => {
    const abort = new AbortController();
    return Effect.gen(function* () {
      const { permissions } = make();
      const a = yield* Effect.forkChild(permissions.request("a", request, never));
      const b = yield* Effect.forkChild(permissions.request("b", request, abort.signal));
      const c = yield* Effect.forkChild(permissions.request("c", request, never));
      yield* Effect.yieldNow;
      permissions.cancel("a");
      assert.deepStrictEqual(yield* Fiber.join(a), CANCELLED);
      abort.abort();
      assert.deepStrictEqual(yield* Fiber.join(b), CANCELLED);
      permissions.cancel();
      assert.deepStrictEqual(yield* Fiber.join(c), CANCELLED);
    });
  });
});

describe("DraftStore", () => {
  const image: Attachment = { kind: "data", name: "a.png", mimeType: "image/png", data: Buffer.from("png bytes").toString("base64") };

  it.effect("stores raw bytes in files, reads them back and removes the unused ones", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const holders: DraftHolder[] = [{}];
      const store = new DraftStore(dir, () => holders);
      yield* store.set(holders[0]!, { text: "look", inline: [{ token: "@a.png", attachment: image }], attachments: [] }, () => true);
      const saved = holders[0]!.savedDraft!;
      assert.strictEqual(saved.inline[0]!.attachment.kind, "stored");
      assert.lengthOf(yield* fs.readDirectory(dir), 1);

      // A text-only update keeps the stored attachments.
      yield* store.set(holders[0]!, "look here", () => true);
      assert.strictEqual(holders[0]!.savedDraft!.text, "look here");
      assert.deepStrictEqual(holders[0]!.savedDraft!.inline, saved.inline);

      // After a reload only the saved form is known.
      const reloaded: DraftHolder[] = [{ savedDraft: holders[0]!.savedDraft }];
      yield* new DraftStore(dir, () => reloaded).load();
      assert.deepStrictEqual(reloaded[0]!.draft, { text: "look here", inline: [{ token: "@a.png", attachment: image }], attachments: [] });

      // Emptying the draft drops its file.
      yield* store.set(holders[0]!, { text: "", inline: [], attachments: [] }, () => true);
      assert.isUndefined(holders[0]!.savedDraft);
      assert.lengthOf(yield* fs.readDirectory(dir), 0);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
  );

  it.effect("drops an update whose tab closed, and attachments whose file is gone", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const holder: DraftHolder = {};
      const store = new DraftStore(dir, () => [holder]);
      yield* store.set(holder, { text: "x", inline: [], attachments: [image] }, () => false);
      assert.isUndefined(holder.savedDraft);

      const missing: DraftHolder = {
        savedDraft: { text: "t", inline: [], attachments: [{ kind: "stored", name: "a.png", mimeType: "image/png", file: "nope" }] },
      };
      yield* new DraftStore(dir, () => [missing]).load();
      assert.deepStrictEqual(missing.draft, { text: "t", inline: [], attachments: [] });
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
  );
});

describe("history", () => {
  const agentWith = (caps: acp.AgentCapabilities, pages: Record<string, acp.ListSessionsResponse[]>) => {
    const calls: Array<[string, string | undefined]> = [];
    const agent = {
      initializeResponse: { protocolVersion: 1, agentCapabilities: caps },
      listSessions: (cwd: string, cursor?: string) => {
        calls.push([cwd, cursor]);
        const index = cursor === undefined ? 0 : Number(cursor);
        return Effect.succeed(pages[cwd]?.[index] ?? { sessions: [] });
      },
    } as unknown as AcpAgent;
    return { agent, calls };
  };
  const session = (sessionId: string, cwd: string): acp.SessionInfo => ({ sessionId, cwd });

  it.effect("lists every folder, following cursors, each session once", () =>
    Effect.gen(function* () {
      const { agent, calls } = agentWith(
        { loadSession: true, sessionCapabilities: { list: {} } },
        {
          "/w/a": [{ sessions: [session("1", "/w/a")], nextCursor: "1" }, { sessions: [session("2", "/w/a")] }],
          "/w/b": [{ sessions: [session("3", "/w/b"), session("1", "/w/a")] }],
        },
      );
      const listing = yield* listHistory(agent, ["/w/a", "/w/b"]);
      assert.isFalse(listing.unsupported);
      if (!listing.unsupported) {
        assert.deepStrictEqual(listing.sessions.map((s) => s.sessionId), ["1", "2", "3"]);
        assert.isTrue(listing.canOpen);
      }
      assert.deepStrictEqual(calls, [["/w/a", undefined], ["/w/a", "1"], ["/w/b", undefined]]);
    }),
  );

  it.effect("says when the agent can't list or reopen sessions", () =>
    Effect.gen(function* () {
      const none = agentWith({}, {});
      assert.isTrue((yield* listHistory(none.agent, ["/w"])).unsupported);
      assert.lengthOf(none.calls, 0);
      const listOnly = agentWith({ sessionCapabilities: { list: {} } }, {});
      const listing = yield* listHistory(listOnly.agent, ["/w"]);
      assert.isFalse(!listing.unsupported && listing.canOpen);
      assert.isFalse(canReopen(listOnly.agent));
      assert.isTrue(canReopen(agentWith({ sessionCapabilities: { resume: {} } }, {}).agent));
    }),
  );

  it.effect("skips a folder the agent can't list, unless none can be listed", () =>
    Effect.gen(function* () {
      const failing = (ok: string[]) =>
        ({
          initializeResponse: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { list: {} } } },
          listSessions: (cwd: string) =>
            ok.includes(cwd) ? Effect.succeed({ sessions: [session("1", cwd)] }) : Effect.fail(new AgentRequestError({ method: "session/list", message: `no ${cwd}`, cause: undefined })),
        }) as unknown as AcpAgent;
      const partial = yield* listHistory(failing(["/w/b"]), ["/w/a", "/w/b"]);
      assert.isFalse(partial.unsupported);
      const error = yield* Effect.flip(listHistory(failing([]), ["/w/a", "/w/b"]));
      assert.strictEqual(error.message, "no /w/a");
    }),
  );

  it("only the latest request may post", () => {
    const requests = new HistoryRequests();
    const first = requests.next();
    assert.isTrue(first());
    const second = requests.next();
    assert.isFalse(first());
    assert.isTrue(second());
  });
});

describe("rewind and fork state", () => {
  it("drops a user message and everything after it from the transcript", () => {
    const actions: Action[] = [
      { type: "add", item: { kind: "userMessage", text: "one", attachments: [], turn: 1 } },
      { type: "chunk", kind: "assistant", text: "reply one" },
      { type: "add", item: { kind: "userMessage", text: "two", attachments: [], turn: 2 } },
      { type: "chunk", kind: "assistant", text: "reply two" },
    ];
    const state = actions.reduce(transcript, EMPTY);
    const rewound = transcript(state, { type: "rewind", turn: 2 });
    assert.deepStrictEqual(
      rewound.items.map((i) => ("text" in i ? i.text : i.kind)),
      ["one", "reply one"],
    );
    assert.isUndefined(rewound.streaming);
    // A turn no longer shown changes nothing.
    assert.strictEqual(transcript(rewound, { type: "rewind", turn: 2 }), rewound);
  });

  it("names inline attachments by their token in a message's text", () => {
    const file: Attachment = { kind: "uri", uri: "file:///w/a.ts", name: "a.ts" };
    assert.strictEqual(messageText(["look at ", { ...file, token: "@a.ts" }, " please", file]), "look at @a.ts please");
  });

  it("forgets the queue, the sent messages and the rewind note when a tab starts over", () => {
    const tabs = new TabList(undefined, () => "/w");
    const tab = tabs.active;
    tab.queue.push({ id: 1, parts: ["later"], includeActiveFile: false });
    tab.steer = true;
    tab.sent.set(3, { parts: ["sent"], includeActiveFile: false });
    tab.rewindNote = "note";
    resetConversation(tab);
    assert.deepStrictEqual(tab.queue, []);
    assert.isFalse(tab.steer);
    assert.strictEqual(tab.sent.size, 0);
    assert.isUndefined(tab.rewindNote);
  });
});

describe("fileLinkTokens", () => {
  it("turns the file links of a replayed user message into tokens", () => {
    const { text, tokens } = fileLinkTokens("see[@READ ME.md](file:///a/READ%20ME.md)and [@x.ts](file:///C:/b/x.ts). [y](https://y)");
    assert.strictEqual(text, "see @READ ME.md and @x.ts. [y](https://y)");
    assert.deepStrictEqual(tokens, [
      { token: "@READ ME.md", path: "/a/READ ME.md" },
      { token: "@x.ts", path: "C:/b/x.ts" },
    ]);
  });

  it("drops embedded file contents and the open file's selection", () => {
    const uri = "file:///w/README.md";
    const { text, tokens } = fileLinkTokens(
      `[@README.md#L12](${uri}#L12) fix this[@README.md](${uri})Selection (README.md:12-12):\n- line\n<context ref="${uri}#L12">\n- line\n</context>`,
    );
    assert.strictEqual(text, "@README.md#L12 fix this @README.md");
    assert.deepStrictEqual(tokens, [
      { token: "@README.md#L12", path: "/w/README.md" },
      { token: "@README.md", path: "/w/README.md" },
    ]);
  });
});

describe("replayedParts", () => {
  it("turns a replayed user message back into composer parts", () => {
    const uri = "file:///w/README.md";
    const parts = replayedParts([
      { type: "text", text: `fix[@README.md](${uri})and ` },
      { type: "image", mimeType: "image/jpeg", data: "AAA" },
      { type: "text", text: ` here\n<context ref="${uri}">\n- line\n</context>` },
    ]);
    assert.deepStrictEqual(parts, [
      "fix ",
      { kind: "uri", uri, name: "README.md", token: "@README.md" },
      " and ",
      { kind: "data", name: "image.jpg", mimeType: "image/jpeg", data: "AAA", token: "@image.jpg" },
      " here",
    ]);
    assert.strictEqual(messageText(parts), "fix @README.md and @image.jpg here");
  });
});
