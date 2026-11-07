import type * as acp from "@agentclientprotocol/sdk";
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import type { CatalogState } from "../agentCatalog";
import type { DoctorState } from "../doctor";
import type { TabGroupInfo, TabInfo, TerminalSnapshot, WorkspaceFolderInfo } from "../chat/protocol";
import { ErrorBoundary } from "./errorBoundary";
import { Lightbox } from "./lightbox";
import { useL10n, type Translate } from "./l10n";
import { mount } from "./mount";
import { useMessages } from "./vscode";
import { BackgroundTasksBar } from "./chat/backgroundTasks";
import { ChangesBar } from "./chat/changes";
import {
  BackgroundToolCalls,
  HoverPreview,
  OpenDiagram,
  OpenPreview,
  ShownTab,
  Terminals,
  type Hover,
  type Preview,
} from "./chat/context";
import { useComposer } from "./chat/composer";
import { GroupPanel } from "./chat/groupPanel";
import type { History } from "./chat/history";
import { post } from "./chat/post";
import { NEW_TAB, TabSidebar, tabStates, type TabState } from "./chat/tabs";
import { formatDuration, useNow, WAITING_AFTER_MS } from "./chat/time";
import type { AgentChoices } from "./chat/agentPanel";
import { takeSavedFavorites } from "./chat/modelFavorites";
import { quickConfig } from "./chat/sessionConfig";
import { AgentSetup, needsSetup } from "./chat/agentSetup";
import { UsageMeter } from "./chat/usageMeter";
import { PrDraftForm, WorkspaceBar } from "./chat/workspaceControls";
import {
  clipContent,
  contentText,
  groupActivity,
  noticeItem,
  stopReasonText,
  transcript,
  type Action,
} from "./chat/transcript";
import { ActivityView, HoverThumb, ItemView } from "./chat/transcriptView";
import { copySelection } from "./chat/clipboard";
import { conversationMarkdown } from "./chat/exportMarkdown";
import { TranscriptSearch } from "./chat/transcriptSearch";

/** The transcript only lives here, so an entry that fails to render must not take the rest down with it. */
/** kdCode.fontSize and kdCode.codeFontSize: sizes in pixels for the chat's CSS, where 0 keeps VS Code's. */
function applyDisplay(fontSize: unknown, codeFontSize: unknown): void {
  const root = document.documentElement.style;
  const apply = (variable: string, size: unknown) =>
    typeof size === "number" && size > 0 ? root.setProperty(variable, `${size}px`) : root.removeProperty(variable);
  apply("--chat-font-size", fontSize);
  apply("--chat-code-font-size", codeFontSize);
}

function EntryBoundary({ items, children }: { items: readonly unknown[]; children: ReactNode }) {
  const { t } = useL10n();
  return (
    <ErrorBoundary
      resetKeys={items}
      fallback={(message) => <div className="error">{t("chat.entryFailed", message)}</div>}
    >
      {children}
    </ErrorBoundary>
  );
}

/** How long a hover over the sidebar doesn't list the conversations again. */
const HISTORY_FRESH_MS = 30_000;

function App() {
  const { t } = useL10n();
  const [tabs, setTabs] = useState<TabInfo[]>([]);
  const [groups, setGroups] = useState<TabGroupInfo[]>([]);
  const [active, setActive] = useState<number>();
  /** The group whose comparison is shown, instead of the active tab. */
  const [shownGroup, setShownGroup] = useState<number>();
  const [states, dispatchTabs] = useReducer(tabStates, {});
  const [agents, setAgents] = useState<AgentChoices>({ agents: [] });
  /** The host told which agents there are, so an empty list means none. */
  const [agentsKnown, setAgentsKnown] = useState(false);
  const [catalog, setCatalog] = useState<CatalogState>({ agents: [], loading: true });
  const [setupDoctor, setSetupDoctor] = useState<DoctorState>({ rows: [], running: false });
  const setup = needsSetup(agents.agents, catalog);
  /** The conversation and the composer; they wait for an agent. */
  const chatShown = agentsKnown && !setup;
  const [folders, setFolders] = useState<WorkspaceFolderInfo[]>([]);
  const [remote, setRemote] = useState(false);
  const [history, setHistory] = useState<History>();
  /** When the history was last asked for; undefined until the sidebar first wants it. */
  const historyAsked = useRef<number>(undefined);
  /** Asks for the history, unless it was just read and nothing outdated it (`force`). The sidebar wants it at each hover. */
  const loadHistory = useCallback((force?: boolean) => {
    const now = Date.now();
    if (force !== true && historyAsked.current !== undefined && now - historyAsked.current < HISTORY_FRESH_MS) return;
    historyAsked.current = now;
    post({ type: "history" });
  }, []);
  /** Counts the requests to go to the sidebar's search box. */
  const [searchRequest, setSearchRequest] = useState(0);
  /** The tab whose name is being edited in the sidebar. */
  const [renaming, setRenaming] = useState<number>();
  /** Counts the requests for the find box; 0 while it is closed. */
  const [findRequest, setFindRequest] = useState(0);
  const [findMessagesOnly, setFindMessagesOnly] = useState(false);
  const messages = useRef<HTMLDivElement>(null);
  /** The active tab for callbacks registered once (drop, FileReader). */
  const activeRef = useRef(active);
  activeRef.current = active;
  const shownGroupRef = useRef(shownGroup);
  shownGroupRef.current = shownGroup;

  const [preview, setPreview] = useState<Preview>();
  const closePreview = useCallback(() => setPreview(undefined), []);
  const openDiagram = useCallback((code: string) => post({ type: "openDiagram", code }), []);
  const [hover, setHover] = useState<Hover>();
  const current = (active !== undefined && states[active]) || NEW_TAB;
  const group = groups.find((each) => each.id === shownGroup);
  const {
    transcript: state,
    config,
    configLoading,
    usage,
    compactAt,
    totals,
    status,
    attachments,
    commands,
    busySince,
    lastActivity,
    terminals: agentTerminals,
    prDraft,
    changes,
    hunks,
    queue,
    editing,
    backgroundTasks,
  } = current;
  /** kdCode.autoScroll: new content scrolls the messages to the end. */
  const [autoScroll, setAutoScroll] = useState(true);
  const autoScrollRef = useRef(autoScroll);
  autoScrollRef.current = autoScroll;
  /** kdCode.showChanges: the files changed bar above the composer. */
  const [showChanges, setShowChanges] = useState(true);
  /** kdCode.tracing: the numbers below each turn. */
  const [tracing, setTracing] = useState(false);
  const checkpointTurns = changes?.turns;
  const canFork = tabs.find((x) => x.id === active)?.canFork ?? false;
  const shownTab = useMemo<ShownTab>(
    () => ({ id: active, busy: !!status.busy, canFork, checkpoints: new Set(checkpointTurns) }),
    [active, status.busy, canFork, checkpointTurns],
  );
  const backgroundToolCalls = useMemo(
    () => new Set(backgroundTasks.flatMap((task) => task.toolCallId ?? [])),
    [backgroundTasks],
  );
  const now = useNow(busySince !== undefined);
  const silent = busySince !== undefined ? Math.max(0, now - (lastActivity ?? busySince)) : 0;

  const update = (tab: number | undefined, f: (s: TabState) => TabState) => {
    if (tab !== undefined) dispatchTabs({ type: "update", tab, f });
  };
  const dispatch = (tab: number | undefined, action: Action) =>
    update(tab, (s) => ({ ...s, transcript: transcript(s.transcript, action) }));

  const error = (key: Parameters<Translate>[0], ...args: unknown[]) =>
    dispatch(activeRef.current, { type: "add", item: { kind: "error", text: { key, args } } });

  // Shown right away; the agent's answer replaces the whole list.
  const setConfigValue = (configId: string, value: string) =>
    update(active, (s) => ({
      ...s,
      config: s.config.map((o) => (o.id === configId ? ({ ...o, currentValue: value } as typeof o) : o)),
    }));

  const composer = useComposer({
    active,
    activeRef,
    tabs,
    states,
    attachments,
    queue,
    editing,
    commands,
    busy: !!status.busy,
    agents,
    folders,
    remote,
    update,
    error,
    setPreview,
    setHover,
    usage: (
      <UsageMeter
        usage={usage}
        compactAt={compactAt}
        totals={totals}
        busy={!!status.busy}
        onCompact={
          active !== undefined && commands.some((c) => c.name === "compact")
            ? () => post({ type: "send", tab: active, parts: ["/compact"] })
            : undefined
        }
      />
    ),
    agentConfig:
      active !== undefined ? { options: config, loading: !!configLoading, onChange: setConfigValue } : undefined,
    quickConfig: active !== undefined && !configLoading && quickConfig(config),
    config,
    hidden: group !== undefined || !chatShown,
  });

  /** Back to the active tab, for what lands in its composer while a group's comparison is shown. */
  const showComposer = () => {
    if (activeRef.current !== undefined && shownGroupRef.current !== undefined) selectTab(activeRef.current);
  };

  useMessages((msg) => {
    // Messages about one conversation name their tab.
    const tab: number | undefined = msg.tab ?? activeRef.current;
    switch (msg.type) {
      case "tabs":
        setTabs(msg.tabs);
        setGroups(msg.groups);
        setActive(msg.active);
        setShownGroup(msg.shownGroup);
        dispatchTabs({ type: "keep", ids: msg.tabs.map((x: TabInfo) => x.id) });
        composer.seed(msg.tabs);
        return;
      case "update":
        update(tab, (s) => (s.status.busy ? { ...s, lastActivity: Date.now() } : s));
        return handleUpdate(tab, msg.update, msg.turn);
      case "userMessage":
        return dispatch(tab, {
          type: "add",
          item: { kind: "userMessage", text: msg.text, attachments: msg.attachments ?? [], turn: msg.turn },
        });
      case "terminal": {
        const snapshot: TerminalSnapshot = msg.snapshot;
        return update(tab, (s) => ({ ...s, terminals: { ...s.terminals, [snapshot.terminalId]: snapshot } }));
      }
      case "changes":
        return update(tab, (s) => ({ ...s, changes: { files: msg.files, turns: msg.turns } }));
      case "hunks":
        return update(tab, (s) => ({ ...s, hunks: { ...s.hunks, [msg.path]: msg.hunks } }));
      case "worktreeDiff":
        return update(tab, (s) => ({ ...s, worktreeDiff: msg.diff }));
      case "prDraft":
        return update(tab, (s) => ({ ...s, prDraft: msg.draft }));
      case "prPending":
        return update(tab, (s) => (s.prDraft ? { ...s, prDraft: { ...s.prDraft, pending: msg.pending } } : s));
      case "queue":
        return update(tab, (s) => ({ ...s, queue: msg.items }));
      case "backgroundTasks":
        return update(tab, (s) => ({ ...s, backgroundTasks: msg.tasks }));
      case "loadComposer":
        if (tab !== undefined) composer.load(tab, msg.parts, msg.rewind);
        return;
      case "rewind":
        return dispatch(tab, { type: "rewind", turn: msg.turn });
      case "forked":
        if (tab !== undefined) dispatchTabs({ type: "fork", from: msg.from, tab });
        return;
      case "autoScroll":
        return setAutoScroll(msg.enabled);
      case "showChanges":
        return setShowChanges(msg.enabled);
      case "tracing":
        return setTracing(msg.enabled);
      case "display":
        return applyDisplay(msg.fontSize, msg.codeFontSize);
      case "turnTrace":
        return dispatch(tab, { type: "add", item: { kind: "trace", trace: msg.trace } });
      case "turnTraces":
        return dispatch(tab, { type: "restoreTraces", traces: msg.traces });
      case "turnEnd": {
        const text = stopReasonText(msg.stopReason);
        return dispatch(tab, text ? { type: "add", item: { kind: "notice", text } } : { type: "endStream" });
      }
      case "session":
        // A loaded session's replayed history ends here.
        dispatch(tab, { type: "endStream" });
        return update(tab, (s) => ({ ...s, config: msg.configOptions ?? [], configLoading: false }));
      case "history":
        // A refresh leaves the list in place until the new one comes.
        return setHistory((h) => (msg.loading && h?.sessions.length ? { ...h, loading: true } : msg));
      case "searchConversations":
        loadHistory(true);
        return setSearchRequest((n) => n + 1);
      case "sessionDeleted":
        return setHistory((h) => h && { ...h, sessions: h.sessions.filter((s) => s.sessionId !== msg.sessionId) });
      case "notice":
        return dispatch(tab, { type: "add", item: { kind: "notice", text: { key: msg.key, args: msg.args } } });
      case "compactWindow":
        return update(tab, (s) => ({ ...s, compactAt: msg.size ?? undefined }));
      case "configOptions":
        if (msg.configOptions) update(tab, (s) => ({ ...s, config: msg.configOptions, configLoading: false }));
        return;
      case "permissionRequest":
        return dispatch(tab, {
          type: "add",
          item: {
            kind: "permission",
            requestId: msg.id,
            toolCall: { ...msg.toolCall, content: clipContent(msg.toolCall.content) },
            options: msg.options,
            done: false,
          },
        });
      case "permissionDone":
        return dispatch(tab, { type: "permissionDone", requestId: msg.id });
      case "elicitationRequest":
        return dispatch(tab, {
          type: "add",
          item: {
            kind: "elicitation",
            requestId: msg.id,
            message: msg.message,
            toolCallId: msg.toolCallId ?? undefined,
            ...(msg.url ? { url: msg.url, elicitationId: msg.elicitationId } : { schema: msg.schema }),
          },
        });
      case "elicitationComplete":
        return dispatch(tab, { type: "elicitationComplete", elicitationId: msg.elicitationId });
      case "elicitationDone":
        return dispatch(tab, { type: "elicitationDone", requestId: msg.id, action: msg.action });
      case "status":
        if (msg.stopped) {
          dispatch(tab, { type: "agentStopped" });
        }
        return update(tab, (s) => {
          const busySince = msg.busy ? (s.busySince ?? Date.now()) : undefined;
          // No session is coming until the user acts.
          const configLoading = s.configLoading && !msg.needsLogin && !msg.needsAgent && !msg.stopped;
          return { ...s, status: msg, busySince, lastActivity: msg.busy ? s.lastActivity : undefined, configLoading };
        });
      case "error":
        // E.g. the agent failed to start.
        update(tab, (s) => ({ ...s, configLoading: false }));
        return dispatch(tab, { type: "add", item: { kind: "error", text: { raw: msg.text } } });
      case "agent": {
        setAgentsKnown(true);
        const saved = takeSavedFavorites();
        if (saved) post({ type: "importFavorites", favorites: saved });
        return setAgents({ agents: msg.agents, activeId: msg.activeId, favorites: msg.favorites });
      }
      case "catalog":
        return setCatalog(msg.catalog);
      case "doctor":
        return setSetupDoctor(msg.doctor);
      case "folders":
        return setFolders(msg.folders);
      case "environment":
        return setRemote(msg.remote);
      case "addAttachments":
        showComposer();
        if (msg.prompt) composer.write(msg.prompt);
        for (const a of msg.attachments) composer.addAttachment(a);
        composer.focus();
        return;
      case "quote":
        showComposer();
        return composer.quote(msg.text);
      case "focusComposer":
        showComposer();
        return composer.focus();
      case "findInConversation":
        if (!chatShown) return;
        showComposer();
        return setFindRequest((n) => n + 1);
      case "exportConversation": {
        const info = tabs.find((x) => x.id === msg.tab);
        const markdown = conversationMarkdown(t, states[msg.tab]?.transcript.items ?? [], {
          title: info?.title || t("chat.newTab"),
          agent: agents.agents.find((x) => x.id === info?.agentId)?.name,
          date: new Date().toLocaleString(),
        });
        return post({ type: "saveConversation", tab: msg.tab, markdown });
      }
      case "sessionTotals":
        return update(tab, (s) => ({ ...s, totals: msg.totals ?? undefined }));
      case "renameTab":
        return setRenaming(msg.tab);
      case "files":
        return composer.setSearchResults(msg.id, msg.files, msg.terminals, msg.problems);
      case "skills":
        return composer.setSkills(msg.skills);
      case "attemptOptions":
        return composer.setAttemptOptions(msg);
      case "reset":
        if (tab !== undefined) composer.endEdit(tab);
        dispatch(tab, { type: "reset" });
        update(tab, (s) => ({
          ...s,
          config: [],
          configLoading: true,
          usage: undefined,
          compactAt: undefined,
          totals: undefined,
          terminals: {},
          queue: [],
          backgroundTasks: [],
        }));
        return;
    }
  });
  // After useMessages, so the listener is in place before the extension answers.
  useEffect(() => post({ type: "ready" }), []);
  // Keybindings scoped to the chat need to know when focus is in here (see the "focus" message).
  useEffect(() => {
    const onFocus = () => post({ type: "focus", focused: true });
    const onBlur = () => post({ type: "focus", focused: false });
    if (document.hasFocus()) onFocus();
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  function handleUpdate(tab: number | undefined, u: acp.SessionUpdate, turn?: number): void {
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
        return dispatch(tab, { type: "chunk", kind: "assistant", text: contentText(u.content) });
      case "agent_thought_chunk":
        return dispatch(tab, { type: "chunk", kind: "thought", text: contentText(u.content) });
      case "user_message_chunk":
        return dispatch(
          tab,
          u.content.type === "image"
            ? {
                type: "chunk",
                kind: "user",
                text: "",
                image: `data:${u.content.mimeType};base64,${u.content.data}`,
                turn,
              }
            : { type: "chunk", kind: "user", text: contentText(u.content), turn },
        );
      case "tool_call":
      case "tool_call_update":
        return dispatch(tab, { type: "toolCall", update: u });
      case "plan":
        return dispatch(tab, { type: "plan", entries: u.entries });
      case "config_option_update":
        return update(tab, (s) => ({ ...s, config: u.configOptions, configLoading: false }));
      case "available_commands_update":
        return update(tab, (s) => ({ ...s, commands: u.availableCommands }));
      case "usage_update":
        return update(tab, (s) => ({ ...s, usage: { used: u.used, size: u.size, cost: u.cost } }));
      case "session_info_update":
        // The host renames the tab.
        return;
      case "notice":
        return dispatch(tab, { type: "add", item: noticeItem(u) });
      case "compaction_update":
        return dispatch(tab, { type: "compaction", update: u });
      case "compaction_summary_chunk":
        return dispatch(tab, { type: "compactionChunk", compactionId: u.compactionId, text: contentText(u.content) });
    }
  }

  function selectTab(id: number): void {
    if (id === activeRef.current && shownGroupRef.current === undefined) return;
    setActive(id);
    setShownGroup(undefined);
    post({ type: "selectTab", tab: id });
  }

  function selectGroup(id: number): void {
    setShownGroup(id);
    post({ type: "selectGroup", group: id });
  }

  // The list is per agent and leaves out the conversations in tabs, so these changes outdate it. Only once it's wanted:
  // the sidebar doesn't list anything before it first opens.
  const activeAgentId = tabs.find((x) => x.id === active)?.agentId;
  const openSessions = tabs
    .flatMap((x) => x.sessionId ?? [])
    .sort()
    .join();
  const historySource = useRef({ agent: activeAgentId, sessions: openSessions });
  useEffect(() => {
    const { agent, sessions } = historySource.current;
    if (agent === activeAgentId && sessions === openSessions) return;
    historySource.current = { agent: activeAgentId, sessions: openSessions };
    if (historyAsked.current === undefined) return;
    if (agent !== activeAgentId) setHistory(undefined);
    loadHistory(true);
  }, [activeAgentId, openSessions]);

  // Switching tabs or sending a message always shows the end. Other new content does only while the view
  // follows the end, and never with auto-scroll off.
  const pinned = useRef(true);
  const stopFollowing = useCallback(() => {
    pinned.current = false;
  }, []);
  const shownTabId = useRef(active);
  const lastItem = useRef<unknown>(undefined);
  useLayoutEffect(() => {
    const el = messages.current;
    const last = state.items.at(-1);
    const sent = last !== lastItem.current && last?.kind === "userMessage";
    lastItem.current = last;
    if (shownTabId.current !== active || sent) pinned.current = true;
    else if (!autoScrollRef.current) pinned.current = false;
    shownTabId.current = active;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [state.items, active]);

  // Turning auto-scroll on jumps to the end.
  useLayoutEffect(() => {
    const el = messages.current;
    if (!autoScroll || !el) return;
    pinned.current = true;
    el.scrollTop = el.scrollHeight;
  }, [autoScroll]);

  // Entries off screen skip rendering (content-visibility), so their real height shows up only later:
  // keep following the end while the view is there. Scrolling up stops it, reaching the end again resumes it.
  useEffect(() => {
    const el = messages.current;
    if (!el) return;
    let lastTop = el.scrollTop;
    const onScroll = () => {
      const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 4;
      pinned.current = atEnd || (pinned.current && el.scrollTop >= lastTop);
      lastTop = el.scrollTop;
    };
    const resized = new ResizeObserver(() => {
      if (pinned.current) el.scrollTop = el.scrollHeight;
    });
    for (const child of el.children) resized.observe(child);
    const changed = new MutationObserver((records) => {
      for (const r of records) {
        for (const node of r.addedNodes) if (node instanceof Element) resized.observe(node);
        for (const node of r.removedNodes) if (node instanceof Element) resized.unobserve(node);
      }
    });
    changed.observe(el, { childList: true });
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      changed.disconnect();
      resized.disconnect();
    };
  }, []);

  // VS Code builds the native context menu from `data-vscode-context`; the selection is read here,
  // in the capture phase, so it is current when VS Code's own listener runs.
  useEffect(() => {
    const onContextMenu = () => {
      const el = messages.current;
      if (!el) return;
      const sel = window.getSelection();
      const selectedText = sel && !sel.isCollapsed && el.contains(sel.anchorNode) ? sel.toString() : "";
      el.dataset.vscodeContext = JSON.stringify({ webviewSection: "messages", selectedText });
    };
    window.addEventListener("contextmenu", onContextMenu, true);
    return () => window.removeEventListener("contextmenu", onContextMenu, true);
  }, []);

  // A selection copied with images takes them along in its HTML.
  useEffect(() => {
    const el = messages.current;
    if (!el) return;
    const onCopy = (e: ClipboardEvent) => void copySelection(e, el);
    document.addEventListener("copy", onCopy);
    return () => document.removeEventListener("copy", onCopy);
  }, []);
  return (
    <OpenDiagram.Provider value={openDiagram}>
      <OpenPreview.Provider value={setPreview}>
        <HoverPreview.Provider value={setHover}>
          <ShownTab.Provider value={shownTab}>
            <Terminals.Provider value={agentTerminals}>
              <BackgroundToolCalls.Provider value={backgroundToolCalls}>
                <div id="chat-body">
                  <div id="chat-main">
                    {agentsKnown && setup && <AgentSetup catalog={catalog} doctor={setupDoctor} />}
                    {chatShown && group && (
                      <GroupPanel
                        group={group}
                        members={tabs.filter((tab) => tab.group === group.id)}
                        states={states}
                        agents={agents.agents}
                        onOpen={selectTab}
                      />
                    )}
                    {chatShown && !group && findRequest > 0 && (
                      <TranscriptSearch
                        root={messages}
                        resetKey={active}
                        request={findRequest}
                        messagesOnly={findMessagesOnly}
                        onMessagesOnlyChange={setFindMessagesOnly}
                        onReveal={stopFollowing}
                        onClose={() => {
                          setFindRequest(0);
                          composer.focus();
                        }}
                      />
                    )}
                    <div id="messages" ref={messages} hidden={!!group || !chatShown}>
                      {state.items.length === 0 && <div className="empty">{t("chat.empty")}</div>}
                      {groupActivity(tracing ? state.items : state.items.filter((item) => item.kind !== "trace")).map(
                        (entry) =>
                          Array.isArray(entry) ? (
                            <EntryBoundary key={entry[0]!.id} items={entry}>
                              <ActivityView items={entry} />
                            </EntryBoundary>
                          ) : (
                            <EntryBoundary key={entry.id} items={[entry]}>
                              <ItemView item={entry} />
                            </EntryBoundary>
                          ),
                      )}
                      {busySince !== undefined && silent >= WAITING_AFTER_MS && (
                        <div className="waiting">{t("chat.waiting", formatDuration(silent))}</div>
                      )}
                    </div>
                    {chatShown && !group && active !== undefined && (
                      <BackgroundTasksBar tab={active} tasks={backgroundTasks} />
                    )}
                    {chatShown && !group && showChanges && active !== undefined && (
                      <ChangesBar tab={active} changes={changes} hunks={hunks} />
                    )}
                    {chatShown && !group && active !== undefined && prDraft && (
                      <PrDraftForm
                        tab={active}
                        draft={prDraft}
                        onChange={(draft) => update(active, (s) => ({ ...s, prDraft: draft }))}
                      />
                    )}
                    {chatShown && !group && (status.needsLogin || status.needsAgent) && (
                      <div id="status">
                        <span id="status-text">{status.text}</span>
                        {status.needsLogin && (
                          <button onClick={() => post({ type: "login" })}>{t("chat.login")}</button>
                        )}
                        {status.needsAgent && (
                          <button onClick={() => post({ type: "selectAgent" })}>{t("chat.installAgent")}</button>
                        )}
                      </div>
                    )}
                    {composer.element}
                    {chatShown && !group && (
                      <WorkspaceBar
                        tab={tabs.find((x) => x.id === active)}
                        busy={!!status.busy}
                        comparing={composer.comparing}
                        editing={editing !== undefined}
                      />
                    )}
                  </div>
                  {chatShown && (
                    <TabSidebar
                      tabs={tabs}
                      groups={groups}
                      states={states}
                      active={active}
                      shownGroup={shownGroup}
                      agents={agents.agents}
                      showChanges={showChanges}
                      onSelect={selectTab}
                      onSelectGroup={selectGroup}
                      renaming={renaming}
                      onRename={setRenaming}
                      history={history}
                      onNeedHistory={loadHistory}
                      searchRequest={searchRequest}
                      onLeaveSearch={composer.focus}
                    />
                  )}
                </div>
                <div id="drop-overlay" className={composer.dragging && chatShown ? "visible" : undefined}>
                  {t("chat.dropHint")}
                </div>
                {preview && (
                  <Lightbox
                    key={preview.src}
                    src={preview.src}
                    alt={preview.name}
                    onClose={closePreview}
                    saveLabel={t(preview.replace ? "lightbox.save" : "lightbox.attach")}
                    onSave={(src) => {
                      const data = src.slice(src.indexOf(",") + 1);
                      if (preview.replace)
                        preview.replace({ kind: "data", name: preview.name, mimeType: "image/png", data });
                      else
                        composer.addAttachment({
                          kind: "data",
                          name: `${preview.name.replace(/\.[^.]*$/, "") || "image"}-annotated.png`,
                          mimeType: "image/png",
                          data,
                        });
                      closePreview();
                      composer.focus();
                    }}
                    onPopOut={() => {
                      post({ type: "openImage", src: preview.src, name: preview.name });
                      closePreview();
                    }}
                  />
                )}
                {hover && !preview && <HoverThumb hover={hover} />}
              </BackgroundToolCalls.Provider>
            </Terminals.Provider>
          </ShownTab.Provider>
        </HoverPreview.Provider>
      </OpenPreview.Provider>
    </OpenDiagram.Provider>
  );
}

mount(<App />);
