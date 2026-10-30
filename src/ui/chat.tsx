import type * as acp from "@agentclientprotocol/sdk";
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import type { TabInfo, TerminalSnapshot, WorkspaceFolderInfo } from "../chat/protocol";
import { Lightbox } from "./lightbox";
import { useL10n, type Translate } from "./l10n";
import { mount } from "./mount";
import { useMessages } from "./vscode";
import { ChangesBar } from "./chat/changes";
import { HoverPreview, OpenPreview, ShownTab, Terminals, type Hover, type Preview } from "./chat/context";
import { useComposer } from "./chat/composer";
import { HistoryView, type History } from "./chat/history";
import { post } from "./chat/post";
import { NEW_TAB, TabStrip, tabStates, type TabState } from "./chat/tabs";
import { formatDuration, useNow, WAITING_AFTER_MS } from "./chat/time";
import { ChatSettings, ConfigSelect, UsageMeter, type AgentChoices } from "./chat/toolbar";
import { clipContent, contentText, groupActivity, transcript, type Action } from "./chat/transcript";
import { ActivityView, HoverThumb, ItemView } from "./chat/transcriptView";
import { copySelection } from "./chat/clipboard";

function App() {
  const { t } = useL10n();
  const [tabs, setTabs] = useState<TabInfo[]>([]);
  const [active, setActive] = useState<number>();
  const [states, dispatchTabs] = useReducer(tabStates, {});
  const [agents, setAgents] = useState<AgentChoices>({ agents: [] });
  const [folders, setFolders] = useState<WorkspaceFolderInfo[]>([]);
  const [activeFile, setActiveFile] = useState<string>();
  const [remote, setRemote] = useState(false);
  const [history, setHistory] = useState<History>();
  /** The tab whose name is being edited in the strip. */
  const [renaming, setRenaming] = useState<number>();
  const messages = useRef<HTMLDivElement>(null);
  /** The active tab for callbacks registered once (drop, FileReader). */
  const activeRef = useRef(active);
  activeRef.current = active;

  const [preview, setPreview] = useState<Preview>();
  const closePreview = useCallback(() => setPreview(undefined), []);
  const [hover, setHover] = useState<Hover>();
  const current = (active !== undefined && states[active]) || NEW_TAB;
  const {
    transcript: state,
    config,
    usage,
    compactAt,
    totals,
    status,
    attachments,
    commands,
    busySince,
    lastActivity,
    terminals: agentTerminals,
    changes,
    queue,
    editing,
  } = current;
  const [followAgent, setFollowAgent] = useState(false);
  /** codeAcp.autoScroll: new content scrolls the messages to the end. */
  const [autoScroll, setAutoScroll] = useState(true);
  const autoScrollRef = useRef(autoScroll);
  autoScrollRef.current = autoScroll;
  const checkpointTurns = changes?.turns;
  const canFork = tabs.find((x) => x.id === active)?.canFork ?? false;
  const shownTab = useMemo<ShownTab>(
    () => ({ id: active, busy: !!status.busy, canFork, checkpoints: new Set(checkpointTurns) }),
    [active, status.busy, canFork, checkpointTurns],
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
    activeFile,
    remote,
    update,
    error,
    setPreview,
    setHover,
    settings: (
      <>
        <UsageMeter usage={usage} compactAt={compactAt} totals={totals} />
        <ChatSettings followAgent={followAgent} autoScroll={autoScroll} />
      </>
    ),
    agentConfig:
      active !== undefined &&
      config.map((opt) =>
        opt.type === "select" ? (
          <ConfigSelect
            key={opt.id}
            tab={active}
            option={opt}
            // Shown right away; the agent's answer replaces the whole list.
            onChange={(value) =>
              update(active, (s) => ({
                ...s,
                config: s.config.map((o) => (o.id === opt.id ? ({ ...o, currentValue: value } as typeof o) : o)),
              }))
            }
          />
        ) : null,
      ),
  });

  useMessages((msg) => {
    // Messages about one conversation name their tab.
    const tab: number | undefined = msg.tab ?? activeRef.current;
    switch (msg.type) {
      case "tabs":
        setTabs(msg.tabs);
        setActive(msg.active);
        dispatchTabs({ type: "keep", ids: msg.tabs.map((x: TabInfo) => x.id) });
        composer.seed(msg.tabs);
        return;
      case "update":
        update(tab, (s) => (s.status.busy ? { ...s, lastActivity: Date.now() } : s));
        return handleUpdate(tab, msg.update, msg.turn);
      case "userMessage":
        return dispatch(tab, { type: "add", item: { kind: "userMessage", text: msg.text, attachments: msg.attachments ?? [], turn: msg.turn } });
      case "terminal": {
        const snapshot: TerminalSnapshot = msg.snapshot;
        return update(tab, (s) => ({ ...s, terminals: { ...s.terminals, [snapshot.terminalId]: snapshot } }));
      }
      case "changes":
        return update(tab, (s) => ({ ...s, changes: { files: msg.files, turns: msg.turns } }));
      case "queue":
        return update(tab, (s) => ({ ...s, queue: msg.items }));
      case "loadComposer":
        if (tab !== undefined) composer.load(tab, msg.parts, msg.rewind);
        return;
      case "rewind":
        return dispatch(tab, { type: "rewind", turn: msg.turn });
      case "forked":
        if (tab !== undefined) dispatchTabs({ type: "fork", from: msg.from, tab });
        return;
      case "followAgent":
        return setFollowAgent(msg.enabled);
      case "autoScroll":
        return setAutoScroll(msg.enabled);
      case "turnEnd":
        return dispatch(
          tab,
          msg.stopReason === "end_turn"
            ? { type: "endStream" }
            : { type: "add", item: { kind: "notice", text: { key: "chat.stopReason", args: [msg.stopReason] } } },
        );
      case "session":
        // A loaded session's replayed history ends here.
        dispatch(tab, { type: "endStream" });
        return update(tab, (s) => ({ ...s, config: msg.configOptions ?? [] }));
      case "history":
        return setHistory(msg);
      case "notice":
        return dispatch(tab, { type: "add", item: { kind: "notice", text: { key: msg.key } } });
      case "compactWindow":
        return update(tab, (s) => ({ ...s, compactAt: msg.size ?? undefined }));
      case "configOptions":
        if (msg.configOptions) update(tab, (s) => ({ ...s, config: msg.configOptions }));
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
      case "status":
        return update(tab, (s) => {
          const busySince = msg.busy ? (s.busySince ?? Date.now()) : undefined;
          return { ...s, status: msg, busySince, lastActivity: msg.busy ? s.lastActivity : undefined };
        });
      case "error":
        return dispatch(tab, { type: "add", item: { kind: "error", text: { raw: msg.text } } });
      case "agent":
        return setAgents({ agents: msg.agents, activeId: msg.activeId });
      case "folders":
        return setFolders(msg.folders);
      case "activeFile":
        return setActiveFile(msg.name);
      case "environment":
        return setRemote(msg.remote);
      case "addAttachments":
        for (const a of msg.attachments) composer.addAttachment(a);
        composer.focus();
        return;
      case "quote":
        return composer.quote(msg.text);
      case "focusComposer":
        return composer.focus();
      case "sessionTotals":
        return update(tab, (s) => ({ ...s, totals: msg.totals ?? undefined }));
      case "renameTab":
        return setRenaming(msg.tab);
      case "files":
        return composer.setSearchResults(msg.id, msg.files, msg.terminals, msg.problems);
      case "skills":
        return composer.setSkills(msg.skills);
      case "reset":
        if (tab !== undefined) composer.endEdit(tab);
        dispatch(tab, { type: "reset" });
        update(tab, (s) => ({ ...s, usage: undefined, compactAt: undefined, totals: undefined, terminals: {}, queue: [] }));
        return;
    }
  });
  // After useMessages, so the listener is in place before the extension answers.
  useEffect(() => post({ type: "ready" }), []);


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
            ? { type: "chunk", kind: "user", text: "", image: `data:${u.content.mimeType};base64,${u.content.data}`, turn }
            : { type: "chunk", kind: "user", text: contentText(u.content), turn },
        );
      case "tool_call":
      case "tool_call_update":
        return dispatch(tab, { type: "toolCall", update: u });
      case "plan":
        return dispatch(tab, { type: "plan", entries: u.entries });
      case "config_option_update":
        return update(tab, (s) => ({ ...s, config: u.configOptions }));
      case "available_commands_update":
        return update(tab, (s) => ({ ...s, commands: u.availableCommands }));
      case "usage_update":
        return update(tab, (s) => ({ ...s, usage: { used: u.used, size: u.size, cost: u.cost } }));
      case "session_info_update":
        // The host renames the tab.
        return;
      default: {
        // Not in the ACP schema, but some agents send it.
        const notice = u as { sessionUpdate: string; message?: string; text?: string };
        if (notice.sessionUpdate === "notice") {
          dispatch(tab, { type: "add", item: { kind: "notice", text: { raw: notice.message ?? notice.text ?? JSON.stringify(u) } } });
        }
      }
    }
  }

  function selectTab(id: number): void {
    if (id === active) return;
    setActive(id);
    setHistory(undefined);
    post({ type: "selectTab", tab: id });
  }


  // Reloads an open history list when the active tab switches agent; the list is per agent.
  const activeAgentId = tabs.find((x) => x.id === active)?.agentId;
  const historyAgent = useRef(activeAgentId);
  useEffect(() => {
    if (history && historyAgent.current !== activeAgentId) post({ type: "history" });
    historyAgent.current = activeAgentId;
  }, [activeAgentId]);

  useEffect(() => {
    if (!history) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setHistory(undefined);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [!history]);

  // Switching tabs or sending a message always shows the end. Other new content does only while the view
  // follows the end, and never with auto-scroll off.
  const pinned = useRef(true);
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
    <OpenPreview.Provider value={setPreview}>
      <HoverPreview.Provider value={setHover}>
      <ShownTab.Provider value={shownTab}>
      <Terminals.Provider value={agentTerminals}>
        <TabStrip tabs={tabs} states={states} active={active} onSelect={selectTab} renaming={renaming} onRename={setRenaming} />
        {history && <HistoryView history={history} onClose={() => setHistory(undefined)} />}
        <div id="messages" ref={messages} hidden={!!history}>
          {state.items.length === 0 && <div className="empty">{t("chat.empty")}</div>}
          {groupActivity(state.items).map((entry) =>
            Array.isArray(entry) ? <ActivityView key={entry[0]!.id} items={entry} /> : <ItemView key={entry.id} item={entry} />,
          )}
          {busySince !== undefined && silent >= WAITING_AFTER_MS && (
            <div className="waiting">{t("chat.waiting", formatDuration(silent))}</div>
          )}
        </div>
        <div id="drop-overlay" className={composer.dragging ? "visible" : undefined}>
          {t("chat.dropHint")}
        </div>
        {active !== undefined && <ChangesBar tab={active} changes={changes} />}
        {(status.needsLogin || status.needsAgent) && (
          <div id="status">
            <span id="status-text">{status.text}</span>
            {status.needsLogin && <button onClick={() => post({ type: "login" })}>{t("chat.login")}</button>}
            {status.needsAgent && <button onClick={() => post({ type: "selectAgent" })}>{t("chat.installAgent")}</button>}
          </div>
        )}
        {composer.element}
        {preview && (
          <Lightbox
            key={preview.src}
            src={preview.src}
            alt={preview.name}
            onClose={closePreview}
            saveLabel={t(preview.replace ? "lightbox.save" : "lightbox.attach")}
            onSave={(src) => {
              const data = src.slice(src.indexOf(",") + 1);
              if (preview.replace) preview.replace({ kind: "data", name: preview.name, mimeType: "image/png", data });
              else composer.addAttachment({ kind: "data", name: `${preview.name.replace(/\.[^.]*$/, "") || "image"}-annotated.png`, mimeType: "image/png", data });
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
      </Terminals.Provider>
      </ShownTab.Provider>
      </HoverPreview.Provider>
    </OpenPreview.Provider>
  );
}

mount(<App />);
