import type * as acp from "@agentclientprotocol/sdk";
import { NodeFileSystem } from "@effect/platform-node-shared";
import { assert, beforeEach, describe, it } from "@effect/vitest";
import { Effect, Fiber, FileSystem, Option, Schema } from "effect";
import * as os from "node:os";
import * as path from "node:path";
import { AgentRequestError, type AcpAgent } from "../src/acpClient";
import { DraftStore, type DraftHolder } from "../src/chat/drafts";
import { canReopen, HistoryRequests, listHistory } from "../src/chat/history";
import {
  CANCELLED,
  ELICITATION_CANCELLED,
  parseElicitationUrl,
  Permissions,
  type Answer,
} from "../src/chat/permissions";
import type { Attachment } from "../src/chat/protocol";
import { replayedParts } from "../src/chat/replay";
import type { TabGroupInfo, TabInfo } from "../src/chat/protocol";
import { messageText, resetConversation, SavedTabs, TabList } from "../src/chat/tabs";
import { attemptKey, attemptPick, modelsIn, nextRow, type AttemptRow } from "../src/ui/chat/compareAttempts";
import { folderName, historyGroups, shortTime, type HistoryGroup, type HistorySort } from "../src/ui/chat/historyList";
import {
  attemptStatus,
  diffTotals,
  dropIndex,
  matchingRows,
  memberTitle,
  openRequests,
  requestsLabel,
  rowsInHand,
  sortRows,
  sumChanges,
  tabChanges,
  tabRows,
  tabWorking,
  sumRequests,
  waitingRowKeys,
  workingRowKeys,
  type ShownRow,
} from "../src/ui/chat/tabRows";
import type { TabState } from "../src/ui/chat/tabs";
import { matchesSession } from "../src/ui/chat/search";
import {
  transcript,
  EMPTY,
  fileLinkTokens,
  noticeItem,
  permissionInput,
  stopReasonText,
  type Action,
} from "../src/ui/chat/transcript";
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

describe("TabList groups", () => {
  /** `solo`, then a group of `a` and `b`, then `end`. */
  const grouped = () => {
    const list = new TabList(undefined, () => "/d");
    const solo = list.active;
    const group = list.addGroup("g", "prompt");
    const a = list.add("/a");
    const b = list.add("/b");
    a.group = group;
    b.group = group;
    const end = list.add("/e");
    return { list, group, solo, a, b, end };
  };
  const order = (list: TabList) => list.all.map((tab) => tab.cwd);

  it("keeps a group's tabs together when another tab moves through them", () => {
    const { list, solo, end } = grouped();
    list.move(end, 2);
    assert.deepStrictEqual(order(list), ["/d", "/a", "/b", "/e"]);
    list.move(solo, 1);
    assert.deepStrictEqual(order(list), ["/a", "/b", "/d", "/e"]);
  });

  it("keeps a tab of a group inside it", () => {
    const { list, a, b } = grouped();
    list.move(a, 99);
    assert.deepStrictEqual(order(list), ["/d", "/b", "/a", "/e"]);
    list.move(a, 0);
    assert.deepStrictEqual(order(list), ["/d", "/a", "/b", "/e"]);
    assert.isTrue(list.has(b));
  });

  it("moves a group as a whole", () => {
    const { list, group } = grouped();
    list.moveGroup(group, 2);
    assert.deepStrictEqual(order(list), ["/d", "/e", "/a", "/b"]);
    list.moveGroup(group, 0);
    assert.deepStrictEqual(order(list), ["/a", "/b", "/d", "/e"]);
  });

  it("pins a group's tabs together, and they stay before the others", () => {
    const { list, a, b, solo } = grouped();
    assert.isTrue(list.pin(b, true));
    assert.isTrue(a.pinned);
    assert.deepStrictEqual(order(list), ["/a", "/b", "/d", "/e"]);
    assert.isFalse(list.pin(a, true));
    list.move(solo, 0);
    assert.deepStrictEqual(order(list), ["/a", "/b", "/d", "/e"]);
    assert.isTrue(list.pin(a, false));
    assert.isFalse(b.pinned);
  });

  it("drops a group with its last tab, once, and stops showing it", () => {
    const { list, group, a, b } = grouped();
    const other = list.addGroup("other", "");
    const c = list.add("/c");
    c.group = other;
    list.showGroup(group);
    list.remove(a);
    assert.strictEqual(list.shownGroup, group);
    list.remove(b);
    assert.isUndefined(list.shownGroup);
    // Removed twice: what the other group holds isn't touched.
    assert.strictEqual(list.remove(b), -1);
    assert.deepStrictEqual(list.groups, [other]);
  });

  it("stops showing a group when a tab becomes active", () => {
    const { list, group, solo } = grouped();
    list.showGroup(group);
    assert.strictEqual(list.active, solo);
    list.active = solo;
    assert.isUndefined(list.shownGroup);
  });

  it("restores groups, and repairs what doesn't hold together", () => {
    const { list, group, a } = grouped();
    a.applied = true;
    group.collapsed = true;
    list.showGroup(group);
    const restored = new TabList(list.saved, () => "/d");
    assert.deepStrictEqual(order(restored), order(list));
    assert.strictEqual(restored.groups[0]!.collapsed, true);
    assert.strictEqual(restored.shownGroup, restored.groups[0]);
    assert.isTrue(restored.all[1]!.applied);
    assert.strictEqual(restored.addGroup("next", "").id, group.id + 1);

    const scattered = {
      active: 2,
      groups: [
        { id: 1, title: "g", prompt: "", createdAt: 1 },
        { id: 9, title: "no tabs", prompt: "", createdAt: 1 },
      ],
      shownGroup: 9,
      tabs: [{ cwd: "/a", group: 1, pinned: true }, { cwd: "/x" }, { cwd: "/b", group: 1 }, { cwd: "/y", group: 77 }],
    };
    const repaired = new TabList(scattered, () => "/d");
    assert.deepStrictEqual(order(repaired), ["/a", "/b", "/x", "/y"]);
    assert.deepStrictEqual(
      repaired.all.map((tab) => tab.pinned),
      [true, true, false, false],
    );
    assert.strictEqual(repaired.active.cwd, "/b");
    assert.strictEqual(repaired.groups.length, 1);
    assert.isUndefined(repaired.shownGroup);
    assert.isUndefined(repaired.all[3]!.group);
  });
});

describe("the sidebar's groups", () => {
  const info = (id: number, group?: number): TabInfo => ({
    id,
    group,
    named: false,
    pinned: false,
    cwd: "/",
    used: false,
    canFork: false,
  });
  const group = (id: number): TabGroupInfo => ({ id, title: "g", prompt: "", createdAt: 0, collapsed: false });

  it("puts a group's tabs under one row, and stands alone what has no known group", () => {
    const rows = tabRows([info(1), info(2, 7), info(3, 7), info(4, 8)], [group(7)]);
    assert.deepStrictEqual(
      rows.map((row) => (row.kind === "tab" ? row.tab.id : row.members.map((tab) => tab.id))),
      [1, [2, 3], 4],
    );
  });

  it("works out where tabs drop, counting those that leave from before the line", () => {
    const tabs = [info(1), info(2), info(3), info(4)];
    assert.strictEqual(dropIndex(tabs, [1], 3), 2);
    assert.strictEqual(dropIndex(tabs, [4], 1), 1);
    assert.strictEqual(dropIndex(tabs, [1, 2], 4), 2);
    assert.isUndefined(dropIndex(tabs, [2], 1));
    assert.isUndefined(dropIndex(tabs, [2], 2));
    assert.isUndefined(dropIndex(tabs, [9], 1));
  });

  it("names a tab of a group after its agent, unless the user named it", () => {
    const agents = [{ id: "a", name: "Agent A" }];
    assert.strictEqual(memberTitle({ ...info(1), agentId: "a", title: "From the session" }, agents), "Agent A");
    assert.strictEqual(
      memberTitle({ ...info(1), agentId: "a", attemptLabel: "Big · High" }, agents),
      "Agent A · Big · High",
    );
    assert.strictEqual(
      memberTitle({ ...info(1), agentId: "a", title: "Mine", named: true, attemptLabel: "Big" }, agents),
      "Mine",
    );
    assert.strictEqual(memberTitle({ ...info(1), agentId: "a", title: "Mine", named: true }, agents), "Mine");
    assert.strictEqual(
      memberTitle({ ...info(1), agentId: "gone", title: "From the session" }, agents),
      "From the session",
    );
  });

  it("adds up what a worktree changed, with no lines for binary files", () => {
    assert.deepStrictEqual(
      diffTotals({ files: [{ path: "a", added: 2, removed: 1 }, { path: "b" }, { path: "c", added: 3, removed: 0 }] }),
      { added: 5, removed: 1 },
    );
  });

  it("says where a tab of a group stands", () => {
    const state = (busy: boolean) => ({ transcript: EMPTY, status: { text: "", busy } }) as TabState;
    assert.strictEqual(attemptStatus({ ...info(1), attempt: "running" }, undefined), "bestOf.running");
    assert.strictEqual(attemptStatus({ ...info(1), attempt: "done" }, state(true)), "bestOf.running");
    assert.strictEqual(attemptStatus({ ...info(1), attempt: "done", applied: true }, state(false)), "bestOf.applied");
    assert.strictEqual(attemptStatus({ ...info(1), attempt: "failed" }, state(false)), "bestOf.failed");
    assert.strictEqual(attemptStatus(info(1), state(false)), "bestOf.done");
  });

  describe("what a row says", () => {
    const withItems = (...items: unknown[]) =>
      ({ transcript: { ...EMPTY, items }, status: { text: "" } }) as unknown as TabState;
    const permission = (done: boolean) => ({ kind: "permission", requestId: 1, toolCall: { toolCallId: "t" }, done });
    const question = (outcome?: string) => ({ kind: "elicitation", requestId: 2, message: "?", outcome });
    const t = (key: string, ...args: unknown[]) => [key, ...args].join(" ");

    it("counts the requests still open, by kind", () => {
      assert.deepStrictEqual(openRequests(undefined), { permissions: 0, questions: 0, logins: 0 });
      assert.deepStrictEqual(openRequests(withItems(permission(true), question("accept"))), {
        permissions: 0,
        questions: 0,
        logins: 0,
      });
      assert.deepStrictEqual(
        openRequests(withItems(permission(false), permission(false), permission(true), question())),
        { permissions: 2, questions: 1, logins: 0 },
      );
    });

    it("counts a login the agent needs", () => {
      const state = { ...withItems(), status: { text: "", needsLogin: true } } as TabState;
      assert.deepStrictEqual(openRequests(state), { permissions: 0, questions: 0, logins: 1 });
    });

    it("adds up the requests of several tabs", () => {
      assert.deepStrictEqual(
        sumRequests([
          { permissions: 1, questions: 0, logins: 1 },
          { permissions: 2, questions: 1, logins: 0 },
        ]),
        { permissions: 3, questions: 1, logins: 1 },
      );
    });

    it("names one request, counts several and says nothing without any", () => {
      const open = (permissions: number, questions: number, logins = 0) => ({ permissions, questions, logins });
      assert.strictEqual(requestsLabel(open(0, 0), t), undefined);
      assert.strictEqual(requestsLabel(open(1, 0), t), "chat.tabPermission");
      assert.strictEqual(requestsLabel(open(0, 1), t), "chat.tabQuestion");
      assert.strictEqual(requestsLabel(open(3, 2), t), "chat.tabPermissions 3 · chat.tabQuestions 2");
      assert.strictEqual(requestsLabel(open(1, 0, 1), t), "chat.tabLogin · chat.tabPermission");
    });

    const file = (added: number, removed: number) => ({
      path: "a",
      name: "a",
      added,
      removed,
      created: false,
      deleted: false,
      binary: false,
    });

    it("counts the files awaiting review unless the setting hides them", () => {
      const state = { changes: { files: [file(2, 1), file(0, 4)], turns: [] } } as unknown as TabState;
      assert.deepStrictEqual(tabChanges(state, true), { files: 2, added: 2, removed: 5 });
      assert.strictEqual(tabChanges(state, false), undefined);
      assert.strictEqual(tabChanges({ changes: { files: [], turns: [] } } as unknown as TabState, true), undefined);
      assert.strictEqual(tabChanges(undefined, true), undefined);
    });

    it("prefers a worktree's diff, whatever the setting, unless it couldn't be read", () => {
      const changes = { files: [file(9, 9)], turns: [] };
      const diff = { files: [{ path: "b", added: 1, removed: 0 }, { path: "c" }] };
      assert.deepStrictEqual(tabChanges({ changes, worktreeDiff: diff } as unknown as TabState, false), {
        files: 2,
        added: 1,
        removed: 0,
      });
      assert.strictEqual(tabChanges({ changes, worktreeDiff: { files: [] } } as unknown as TabState, true), undefined);
      assert.deepStrictEqual(
        tabChanges({ changes, worktreeDiff: { files: [], error: "no" } } as unknown as TabState, true),
        { files: 1, added: 9, removed: 9 },
      );
    });

    it("adds up a group's changes", () => {
      assert.strictEqual(sumChanges([]), undefined);
      assert.deepStrictEqual(
        sumChanges([
          { files: 1, added: 2, removed: 3 },
          { files: 4, added: 5, removed: 6 },
        ]),
        { files: 5, added: 7, removed: 9 },
      );
    });
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
    assert.deepStrictEqual(
      list.all.map((t) => t.id),
      [c.id, a.id, b.id],
    );
    assert.isFalse(list.pin(c, true));
    // An unpinned tab can't move into the pinned group.
    list.move(b, 0);
    assert.deepStrictEqual(
      list.all.map((t) => t.id),
      [c.id, b.id, a.id],
    );
    list.pin(c, false);
    assert.deepStrictEqual(
      list.all.map((t) => t.id),
      [c.id, b.id, a.id],
    );
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

describe("sidebar history", () => {
  const session = (sessionId: string, title: string | undefined, cwd: string, updatedAt: string): acp.SessionInfo => ({
    sessionId,
    title,
    cwd,
    updatedAt,
  });
  const sessions = [
    session("old", "Zebra", "/work/b", "2026-01-01T00:00:00Z"),
    session("new", "Đổi tên", "/work/a", "2026-03-01T00:00:00Z"),
    session("none", undefined, "/work/b", "2026-02-01T00:00:00Z"),
    session("open", "Apple", "/work/a", "2026-04-01T00:00:00Z"),
  ];
  const ids = (groups: ReadonlyArray<HistoryGroup>) => groups.map((group) => group.sessions.map((s) => s.sessionId));
  const list = (sort: HistorySort, query = "") =>
    historyGroups(sessions, { openIds: new Set(["open"]), query, sort, lang: "en" });

  it("leaves out conversations in tabs and sorts the rest", () => {
    assert.deepStrictEqual(ids(list("updated")), [["new", "none", "old"]]);
    assert.deepStrictEqual(ids(list("title")), [["new", "old", "none"]]);
  });

  it("groups by folder, the latest first in each", () => {
    const groups = list("folder");
    assert.deepStrictEqual(
      groups.map((group) => group.folder),
      ["/work/a", "/work/b"],
    );
    assert.deepStrictEqual(ids(groups), [["new"], ["none", "old"]]);
  });

  it("filters by the query, ignoring diacritics, and lists no empty group", () => {
    assert.deepStrictEqual(ids(list("folder", "doi")), [["new"]]);
    assert.deepStrictEqual(list("updated", "nothing"), []);
  });

  it("labels the time in short, never with months", () => {
    const now = Date.parse("2026-11-04T12:00:00Z");
    const ago = (seconds: number) => shortTime("en", new Date(now - seconds * 1000).toISOString(), now);
    assert.deepStrictEqual(
      [ago(5), ago(5 * 60), ago(2 * 3600), ago(3 * 86400), ago(60 * 86400), ago(400 * 86400)],
      ["1m", "5m", "2h", "3d", "8w", "1y"],
    );
    assert.strictEqual(shortTime("en", undefined, now), "");
  });

  it("names a folder by its last segment", () => {
    assert.strictEqual(folderName("/work/code-acp/"), "code-acp");
    assert.strictEqual(folderName("C:\\work\\code"), "code");
  });
});

describe("sidebar rows", () => {
  const tab = (id: number, title: string, group?: number) =>
    ({ id, title, group, cwd: "/work", pinned: false, used: true, canFork: false }) as TabInfo;
  const group = { id: 1, title: "Compare", prompt: "", collapsed: true } as unknown as TabGroupInfo;
  const tabs = [tab(1, "Alpha"), tab(2, "Beta", 1), tab(3, "Gamma", 1), tab(4, "Delta")];
  const rows = tabRows(tabs, [group]);
  const titleOf = (each: TabInfo) => each.title ?? "";
  const shown = (each: ReadonlyArray<ShownRow>) =>
    each.map((row) => (row.kind === "tab" ? row.tab.id : row.shown.map((member) => member.id)));

  it("finds tabs, and shows only the tabs of a group that match", () => {
    assert.deepStrictEqual(shown(matchingRows(rows, "alpha", titleOf)), [1]);
    assert.deepStrictEqual(shown(matchingRows(rows, "gamma", titleOf)), [[3]]);
    assert.deepStrictEqual(shown(matchingRows(rows, "compare", titleOf)), [[2, 3]]);
    assert.deepStrictEqual(shown(matchingRows(rows, "nothing", titleOf)), []);
  });

  it("keeps the whole group count when it shows only some of its tabs", () => {
    const [row] = matchingRows(rows, "gamma", titleOf);
    assert.deepStrictEqual(row?.kind === "group" ? row.members.map((member) => member.id) : [], [2, 3]);
  });

  describe("order", () => {
    const at = (each: TabInfo, createdAt?: number, pinned = false) => ({ ...each, createdAt, pinned });
    const list = tabRows(
      [
        at(tab(1, "Alpha"), 30),
        at(tab(2, "Beta", 1), 50),
        at(tab(3, "Gamma", 1), 10),
        at(tab(4, "")),
        at(tab(5, "Delta"), 20),
      ],
      [group],
    );
    const ids = (sort: Parameters<typeof sortRows>[1], each = list) =>
      sortRows(each, sort, (row) => (row.kind === "tab" ? (row.tab.title ?? "") : row.group.title), "en").map((row) =>
        row.kind === "tab" ? row.tab.id : row.members.map((member) => member.id),
      );

    it("keeps the manual order", () => {
      assert.deepStrictEqual(ids("manual"), [1, [2, 3], 4, 5]);
    });

    it("orders by when rows started, a group by its first tab, the unstarted last", () => {
      assert.deepStrictEqual(ids("newest"), [1, 5, [2, 3], 4]);
      assert.deepStrictEqual(ids("oldest"), [[2, 3], 5, 1, 4]);
    });

    it("orders by title, the untitled last", () => {
      assert.deepStrictEqual(ids("title"), [1, [2, 3], 5, 4]);
    });

    it("keeps pinned rows first", () => {
      const pinned = tabRows(
        [at(tab(1, "Alpha"), 30), at(tab(5, "Delta"), 20, true), at(tab(6, "Beta"), 40, true)],
        [],
      );
      assert.deepStrictEqual(ids("newest", pinned), [6, 5, 1]);
      assert.deepStrictEqual(ids("title", pinned), [6, 5, 1]);
    });
  });

  describe("working section", () => {
    const keys = (working: number[], waiting: number[] = [], list = rows) => [
      ...workingRowKeys(
        list,
        (each) => working.includes(each.id),
        (each) => waiting.includes(each.id),
      ),
    ];

    it("takes the tabs and groups with something running", () => {
      assert.deepStrictEqual(keys([1, 3]), ["tab-1", "group-1"]);
      assert.deepStrictEqual(keys([]), []);
    });

    it("leaves what waits on the user, or a whole group when one of its tabs does", () => {
      assert.deepStrictEqual(keys([1], [1]), []);
      assert.deepStrictEqual(keys([2, 3], [3]), []);
    });

    it("leaves pinned tabs where they are", () => {
      assert.deepStrictEqual(keys([1], [], tabRows([{ ...tab(1, "Alpha"), pinned: true }], [])), []);
    });

    it("takes the tabs and groups waiting on the user, except pinned ones", () => {
      const waiting = (ids: number[], list = rows) => [...waitingRowKeys(list, (each) => ids.includes(each.id))];
      assert.deepStrictEqual(waiting([1, 3]), ["tab-1", "group-1"]);
      assert.deepStrictEqual(waiting([]), []);
      assert.deepStrictEqual(waiting([1], tabRows([{ ...tab(1, "Alpha"), pinned: true }], [])), []);
    });

    it("counts a running turn or attempt, or background work, not a session being reopened", () => {
      const status = (status: TabState["status"]) => ({ status, backgroundTasks: [] }) as unknown as TabState;
      assert.isTrue(tabWorking(tab(1, "Alpha"), status({ text: "", busy: true })));
      assert.isFalse(tabWorking(tab(1, "Alpha"), status({ text: "", busy: true, loading: true })));
      assert.isFalse(tabWorking(tab(1, "Alpha"), undefined));
      assert.isTrue(tabWorking({ ...tab(1, "Alpha"), attempt: "running" }, undefined));
      const background = { id: "t1", name: "Bash", taskType: "shell", canStop: true };
      assert.isTrue(
        tabWorking(tab(1, "Alpha"), { ...status({ text: "" }), backgroundTasks: [background] } as TabState),
      );
    });

    it("stays held only by a drag or a rename on rows still there", () => {
      const tabs = [tab(1, "Alpha")];
      const groups = [{ id: 1 } as TabGroupInfo];
      assert.isFalse(rowsInHand(tabs, groups, {}));
      assert.isTrue(rowsInHand(tabs, groups, { renaming: 1 }));
      assert.isTrue(rowsInHand(tabs, groups, { renamingGroup: 1 }));
      assert.isTrue(rowsInHand(tabs, groups, { dragged: [9, 1] }));
      assert.isFalse(rowsInHand(tabs, groups, { renaming: 9 }));
      assert.isFalse(rowsInHand(tabs, groups, { renamingGroup: 9 }));
      assert.isFalse(rowsInHand(tabs, groups, { dragged: [9] }));
    });
  });
});

describe("Permissions", () => {
  const request = {
    sessionId: "s",
    toolCall: { toolCallId: "t" },
    options: [],
  } as unknown as acp.RequestPermissionRequest;

  const make = () => {
    const shown: number[] = [];
    const done: number[] = [];
    const permissions = new Permissions<string>({
      shown: (_, id) => void shown.push(id),
      done: (_, id) => void done.push(id),
    });
    return { permissions, shown, done };
  };
  // The agent's own signals come from outside Effect.
  const never = new AbortController().signal;

  it.effect("lists the tabs with pending requests, each once", () =>
    Effect.gen(function* () {
      const { permissions } = make();
      const fibers = [
        yield* Effect.forkChild(permissions.request("b", request, never)),
        yield* Effect.forkChild(permissions.request("a", request, never)),
        yield* Effect.forkChild(permissions.request("b", request, never)),
      ];
      yield* Effect.yieldNow;
      assert.deepStrictEqual(permissions.owners, ["b", "a"]);
      permissions.cancel("b");
      assert.deepStrictEqual(permissions.owners, ["a"]);
      permissions.cancel();
      assert.deepStrictEqual(permissions.owners, []);
      yield* Fiber.joinAll(fibers);
    }),
  );

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

describe("Permissions with questions", () => {
  it("shows no raw input for an empty one", () => {
    const input = (rawInput: unknown) => permissionInput({ toolCallId: "t", rawInput });
    assert.isUndefined(input(undefined));
    assert.isUndefined(input(null));
    assert.isUndefined(input({}));
    assert.isUndefined(input([]));
    assert.strictEqual(input({ a: 1 }), '{\n  "a": 1\n}');
  });

  const permission = {
    sessionId: "s",
    toolCall: { toolCallId: "t" },
    options: [],
  } as unknown as acp.RequestPermissionRequest;
  const question = {
    sessionId: "s",
    mode: "form",
    message: "Which one?",
    requestedSchema: { type: "object", properties: {} },
  } as const;
  const never = new AbortController().signal;

  it.effect("answers a question with what the user filled in, and cancels it with the tab", () =>
    Effect.gen(function* () {
      const done: Answer[] = [];
      const permissions = new Permissions<string>({ shown: () => {}, done: (_, __, answer) => void done.push(answer) });
      const asked = yield* Effect.forkChild(permissions.elicit("a", question, never));
      const allowed = yield* Effect.forkChild(permissions.request("a", permission, never));
      const other = yield* Effect.forkChild(permissions.elicit("b", question, never));
      yield* Effect.yieldNow;
      assert.deepStrictEqual(permissions.owners, ["a", "b"]);
      // An answer of the other kind is ignored.
      permissions.answer(1, "allow");
      permissions.answerElicitation(2, { action: "decline" });
      assert.deepStrictEqual(done, []);
      permissions.answerElicitation(1, { action: "accept", content: { pick: "x" } });
      assert.deepStrictEqual(yield* Fiber.join(asked), { action: "accept", content: { pick: "x" } });
      permissions.cancel("a");
      assert.deepStrictEqual(yield* Fiber.join(allowed), CANCELLED);
      permissions.cancel();
      assert.deepStrictEqual(yield* Fiber.join(other), ELICITATION_CANCELLED);
      assert.deepStrictEqual(
        done.map((a) => a.kind),
        ["elicitation", "permission", "elicitation"],
      );
    }),
  );

  it("shows an open question on the subagent call that asked it, until it is answered", () => {
    const actions: Action[] = [
      {
        type: "toolCall",
        update: { toolCallId: "agent", title: "Agent", _meta: { claudeCode: { toolName: "Agent" } } },
      },
      {
        type: "toolCall",
        update: { toolCallId: "ask", title: "Ask", _meta: { claudeCode: { parentToolUseId: "agent" } } },
      },
      {
        type: "add",
        item: {
          kind: "elicitation",
          requestId: 7,
          message: "Which one?",
          schema: { type: "object" },
          toolCallId: "ask",
        },
      },
    ];
    const state = actions.reduce(transcript, EMPTY);
    const parent = () => state.items.find((i) => i.kind === "tool");
    assert.deepStrictEqual(parent()?.kind === "tool" && parent()?.waiting, [7]);
    const answered = transcript(state, { type: "elicitationDone", requestId: 7, action: "accept" });
    const tool = answered.items.find((i) => i.kind === "tool");
    assert.deepStrictEqual(tool?.kind === "tool" && tool.waiting, []);
    const form = answered.items.find((i) => i.kind === "elicitation");
    assert.strictEqual(form?.kind === "elicitation" && form.outcome, "accept");
  });

  it("marks only the link that completed", () => {
    const link = (requestId: number, elicitationId: string): Action => ({
      type: "add",
      item: { kind: "elicitation", requestId, message: "Sign in", url: "https://example.com/", elicitationId },
    });
    const state = [
      link(1, "a"),
      link(2, "b"),
      { type: "elicitationComplete", elicitationId: "b" } satisfies Action,
    ].reduce(transcript, EMPTY);
    assert.deepStrictEqual(
      state.items.map((i) => i.kind === "elicitation" && "url" in i && i.completed),
      [undefined, true],
    );
  });

  describe("compaction", () => {
    const compaction = (state: typeof EMPTY) => {
      const item = state.items.find((i) => i.kind === "compaction");
      return item?.kind === "compaction" ? item : undefined;
    };
    const update = (fields: Omit<acp.CompactionUpdate, "compactionId">): Action => ({
      type: "compaction",
      update: { compactionId: "c", ...fields },
    });
    const chunk = (text: string): Action => ({ type: "compactionChunk", compactionId: "c", text });

    it("stays where it started, and updates in place", () => {
      const state = [
        { type: "chunk", kind: "assistant", text: "before" } satisfies Action,
        update({ status: "in_progress" }),
        { type: "chunk", kind: "assistant", text: "after" } satisfies Action,
        update({ status: "completed" }),
      ].reduce(transcript, EMPTY);
      assert.deepStrictEqual(
        state.items.map((i) => i.kind),
        ["assistant", "compaction", "assistant"],
      );
      assert.strictEqual(compaction(state)?.status, "completed");
    });

    it("starts on a first chunk, and appends the next ones in order", () => {
      const state = [chunk("the "), chunk("summary")].reduce(transcript, EMPTY);
      assert.strictEqual(state.items.length, 1);
      assert.strictEqual(compaction(state)?.status, "in_progress");
      assert.strictEqual(compaction(state)?.summary, "the summary");
    });

    it("patches: omitted fields stay, null clears them, a value replaces them", () => {
      const withBoth = [chunk("old"), update({ status: "failed", error: "boom" })].reduce(transcript, EMPTY);
      assert.strictEqual(compaction(withBoth)?.summary, "old");
      assert.strictEqual(compaction(withBoth)?.error, "boom");
      const kept = transcript(withBoth, update({ status: "failed" }));
      assert.strictEqual(compaction(kept)?.summary, "old");
      assert.strictEqual(compaction(kept)?.error, "boom");
      const replaced = transcript(
        kept,
        update({ status: "completed", summary: [{ type: "text", text: "new" }], error: null }),
      );
      assert.strictEqual(compaction(replaced)?.summary, "new");
      assert.isUndefined(compaction(replaced)?.error);
      assert.strictEqual(compaction(transcript(replaced, update({ status: "completed", summary: null })))?.summary, "");
      assert.strictEqual(compaction(transcript(replaced, update({ status: "completed", summary: [] })))?.summary, "");
    });

    it("ends what is running when the agent stops, and leaves what already ended", () => {
      const stopped: Action = { type: "agentStopped" };
      assert.strictEqual(
        compaction([update({ status: "in_progress" }), stopped].reduce(transcript, EMPTY))?.status,
        "cancelled",
      );
      assert.strictEqual(
        compaction([update({ status: "completed" }), stopped].reduce(transcript, EMPTY))?.status,
        "completed",
      );
      assert.strictEqual(
        compaction([update({ status: "failed", error: "boom" }), stopped].reduce(transcript, EMPTY))?.status,
        "failed",
      );
    });
  });
});

describe("parseElicitationUrl", () => {
  const href = (url: string, httpHosts: ReadonlyArray<string> = []) =>
    Option.getOrUndefined(parseElicitationUrl(url, httpHosts))?.href;

  it("takes https links, normalized, keeping what is encoded in them", () => {
    assert.strictEqual(href("https://example.com/a?next=a%26b"), "https://example.com/a?next=a%26b");
    assert.strictEqual(href("https://münchen.example/"), "https://xn--mnchen-3ya.example/");
  });

  it("takes http only to this machine and the hosts the user listed", () => {
    assert.strictEqual(href("http://localhost:8123/callback?code=1"), "http://localhost:8123/callback?code=1");
    assert.strictEqual(href("http://127.0.0.1:8123/"), "http://127.0.0.1:8123/");
    assert.strictEqual(
      href("http://gitlab.internal:8080/login", ["gitlab.internal"]),
      "http://gitlab.internal:8080/login",
    );
    assert.strictEqual(href("http://192.168.1.10/", ["192.168.1.10"]), "http://192.168.1.10/");
    assert.strictEqual(href("http://gitlab.internal/", ["GitLab.Internal"]), "http://gitlab.internal/");
    assert.strictEqual(href("http://xn--mnchen-3ya.example/", ["münchen.example"]), "http://xn--mnchen-3ya.example/");
    for (const url of [
      "http://192.168.1.1/",
      "http://[::1]/",
      "http://localhost.evil.example/",
      "http://evil.example/localhost",
      "http://localhost@evil.example/",
      "http://user:secret@localhost/",
      "http://sub.gitlab.internal/",
    ]) {
      assert.isUndefined(href(url, ["gitlab.internal"]), url);
    }
    assert.isUndefined(href("file://gitlab.internal/etc/passwd", ["gitlab.internal"]));
  });

  it("refuses other schemes, addresses with a user name and what isn't a link", () => {
    for (const url of [
      "http://example.com/",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "vscode://settings",
      "command:workbench.action.reloadWindow",
      "https://bank.example@evil.example/",
      "https://user:secret@example.com/",
      "not a link",
      "",
    ]) {
      assert.isUndefined(href(url), url);
    }
  });
});

describe("DraftStore", () => {
  const image: Attachment = {
    kind: "data",
    name: "a.png",
    mimeType: "image/png",
    data: Buffer.from("png bytes").toString("base64"),
  };

  it.effect("stores raw bytes in files, reads them back and removes the unused ones", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const holders: DraftHolder[] = [{}];
      const store = new DraftStore(dir, () => holders);
      yield* store.set(
        holders[0]!,
        { text: "look", inline: [{ token: "@a.png", attachment: image }], attachments: [] },
        () => true,
      );
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
      assert.deepStrictEqual(reloaded[0]!.draft, {
        text: "look here",
        inline: [{ token: "@a.png", attachment: image }],
        attachments: [],
      });

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
        savedDraft: {
          text: "t",
          inline: [],
          attachments: [{ kind: "stored", name: "a.png", mimeType: "image/png", file: "nope" }],
        },
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
        assert.deepStrictEqual(
          listing.sessions.map((s) => s.sessionId),
          ["1", "2", "3"],
        );
        assert.isTrue(listing.canOpen);
      }
      assert.deepStrictEqual(calls, [
        ["/w/a", undefined],
        ["/w/a", "1"],
        ["/w/b", undefined],
      ]);
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
            ok.includes(cwd)
              ? Effect.succeed({ sessions: [session("1", cwd)] })
              : Effect.fail(new AgentRequestError({ method: "session/list", message: `no ${cwd}`, cause: undefined })),
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

  it("puts a replayed session's traces back at the end of their turns", () => {
    const trace = (stopReason: string) => ({
      stopReason,
      durationMs: 1,
      waiting: { asks: 0, ms: 0 },
      tools: { total: 0, failed: 0, kinds: {} },
      subagents: 0,
      sessionId: "s",
    });
    const actions: Action[] = [
      { type: "chunk", kind: "user", text: "one", turn: 1 },
      { type: "chunk", kind: "assistant", text: "reply one" },
      { type: "chunk", kind: "user", text: "two", turn: 2 },
      { type: "chunk", kind: "assistant", text: "reply two" },
      { type: "chunk", kind: "user", text: "three", turn: 3 },
      { type: "chunk", kind: "assistant", text: "reply three" },
    ];
    const state = actions.reduce(transcript, EMPTY);
    const restored = transcript(state, {
      type: "restoreTraces",
      traces: [
        { turn: 1, trace: trace("first") },
        { turn: 3, trace: trace("third") },
      ],
    });
    assert.deepStrictEqual(
      restored.items.map((i) => (i.kind === "trace" ? i.trace.stopReason : "text" in i ? i.text : i.kind)),
      ["one", "reply one", "first", "two", "reply two", "three", "reply three", "third"],
    );
    assert.strictEqual(new Set(restored.items.map((i) => i.id)).size, restored.items.length);
    assert.isUndefined(restored.streaming);
    // What comes next gets an id of its own, in a new block.
    const next = transcript(restored, { type: "chunk", kind: "assistant", text: "more" });
    assert.strictEqual(next.items.length, restored.items.length + 1);
    assert.strictEqual(new Set(next.items.map((i) => i.id)).size, next.items.length);
  });

  it("names inline attachments by their token in a message's text", () => {
    const file: Attachment = { kind: "uri", uri: "file:///w/a.ts", name: "a.ts" };
    assert.strictEqual(messageText(["look at ", { ...file, token: "@a.ts" }, " please", file]), "look at @a.ts please");
  });

  it("forgets the queue, the sent messages and the rewind note when a tab starts over", () => {
    const tabs = new TabList(undefined, () => "/w");
    const tab = tabs.active;
    tab.queue.push({ id: 1, parts: ["later"] });
    tab.steer = true;
    tab.sent.set(3, { parts: ["sent"] });
    tab.rewindNote = "note";
    resetConversation(tab);
    assert.deepStrictEqual(tab.queue, []);
    assert.isFalse(tab.steer);
    assert.strictEqual(tab.sent.size, 0);
    assert.isUndefined(tab.rewindNote);
  });
});

describe("turn end and notices", () => {
  it("says nothing when a turn ends the way the user expects", () => {
    assert.isUndefined(stopReasonText("end_turn"));
    assert.isUndefined(stopReasonText("cancelled"));
  });

  it("explains the other stop reasons, and shows unknown ones as they are", () => {
    assert.deepStrictEqual(stopReasonText("max_tokens"), { key: "chat.stopReason.maxTokens" });
    assert.deepStrictEqual(stopReasonText("max_turn_requests"), { key: "chat.stopReason.maxTurnRequests" });
    assert.deepStrictEqual(stopReasonText("refusal"), { key: "chat.stopReason.refusal" });
    assert.deepStrictEqual(stopReasonText("_custom"), { key: "chat.stopReason", args: ["_custom"] });
  });

  it("shows a notice's title and description, as an error when it is one", () => {
    assert.deepStrictEqual(noticeItem({ severity: "warning", title: "Slow down", description: "Rate limited" }), {
      kind: "notice",
      text: { raw: "Slow down — Rate limited" },
    });
    assert.deepStrictEqual(noticeItem({ severity: "error", title: "Failed" }), {
      kind: "error",
      text: { raw: "Failed" },
    });
  });
});

describe("fileLinkTokens", () => {
  it("turns the file links of a replayed user message into tokens", () => {
    const { text, tokens } = fileLinkTokens(
      "see[@READ ME.md](file:///a/READ%20ME.md)and [@x.ts](file:///C:/b/x.ts). [y](https://y)",
    );
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

describe("comparison attempts", () => {
  const models = [
    { value: "small", name: "Small" },
    { value: "big", name: "Big" },
  ];
  const row = (agentId: string, model = "", effort = ""): AttemptRow => ({ id: 1, agentId, model, effort });

  it("adds an agent not in the comparison yet, then another model of the last one", () => {
    assert.deepStrictEqual(
      nextRow(2, [row("a", "big", "high")], ["a", "b"], () => models),
      { id: 2, agentId: "b", model: "", effort: "" },
    );
    assert.deepStrictEqual(
      nextRow(2, [row("a", "big", "high")], ["a"], () => models),
      { id: 2, agentId: "a", model: "small", effort: "" },
    );
    assert.deepStrictEqual(
      nextRow(3, [row("a", "big"), row("a", "small")], ["a"], () => models),
      { id: 3, agentId: "a", model: "", effort: "" },
    );
    assert.deepStrictEqual(
      nextRow(2, [row("a")], ["a"], () => undefined),
      { id: 2, agentId: "a", model: "", effort: "" },
    );
  });

  it("labels an attempt with the names of its picks, leaving out an effort the model doesn't have", () => {
    const efforts = [{ value: "high", name: "High" }];
    const options = { models, efforts, fastMode: false };
    const loaded = { [attemptKey("a", "big")]: { agentId: "a", model: "big", options } };
    const modelsOf = (id: string) => modelsIn(loaded, id);
    assert.deepStrictEqual(attemptPick(row("a", "big", "high"), loaded, modelsOf), {
      agentId: "a",
      model: "big",
      effort: "high",
      label: "Big · High",
    });
    assert.deepStrictEqual(attemptPick(row("a", "big", "max"), loaded, modelsOf), {
      agentId: "a",
      model: "big",
      effort: "max",
      label: "Big",
    });
    assert.deepStrictEqual(attemptPick(row("a"), loaded, modelsOf), { agentId: "a", model: "", effort: "" });
    // Not read yet: the values are all there is.
    assert.deepStrictEqual(
      attemptPick(row("b", "m", "e"), {}, () => undefined),
      { agentId: "b", model: "m", effort: "e", label: "m · e" },
    );
  });
});
