import { useState } from "react";
import type { McpServerEntry } from "../../settings";
import { Icon } from "../icon";
import { useL10n } from "../l10n";
import terminalIcon from "@tabler/icons/outline/terminal-2.svg";
import plusIcon from "@tabler/icons/outline/plus.svg";
import pencilIcon from "@tabler/icons/outline/pencil.svg";
import trashIcon from "@tabler/icons/outline/trash.svg";
import serverIcon from "@tabler/icons/outline/server.svg";
import worldIcon from "@tabler/icons/outline/world.svg";
import { Field, Overridden } from "./fields";
import { formatPairs, parsePairs } from "./pairs";
import { set } from "./post";

type McpType = "stdio" | "http" | "sse";

/** The editor form of one server; list fields are kept as text until saved. */
interface McpDraft {
  name: string;
  type: McpType;
  command: string;
  args: string;
  env: string;
  url: string;
  headers: string;
}

const EMPTY_DRAFT: McpDraft = { name: "", type: "stdio", command: "", args: "", env: "", url: "", headers: "" };

/** The servers in the setting, skipping entries that are not objects (hand-edited settings.json). */
export function serversOf(value: unknown): Array<[string, McpServerEntry]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value).filter(
    (e): e is [string, McpServerEntry] =>
      !!e[1] && typeof e[1] === "object" && (typeof e[1].command === "string" || typeof e[1].url === "string"),
  );
}

function toDraft(name: string, entry: McpServerEntry): McpDraft {
  if ("url" in entry) {
    return { ...EMPTY_DRAFT, name, type: entry.type, url: entry.url, headers: formatPairs(entry.headers, ": ") };
  }
  return {
    ...EMPTY_DRAFT,
    name,
    command: entry.command,
    args: (entry.args ?? []).join("\n"),
    env: formatPairs(entry.env),
  };
}

function isUrl(text: string): boolean {
  try {
    new URL(text);
    return true;
  } catch {
    return false;
  }
}

/** Edits one MCP server or, with `agents`, one custom agent (a local command only). */
function EntryEditor(props: {
  agents?: boolean;
  initial: McpDraft;
  /** Names of the other entries; a saved name must not be one of them. */
  taken: ReadonlyArray<string>;
  onSave: (name: string, entry: McpServerEntry) => void;
  onCancel: () => void;
}) {
  const { t } = useL10n();
  const [draft, setDraft] = useState(props.initial);
  const [error, setError] = useState<string>();
  const edit = (patch: Partial<McpDraft>) => setDraft((d) => ({ ...d, ...patch }));

  const save = () => {
    const name = draft.name.trim();
    if (!name) return setError(t("settings.mcpNameRequired"));
    if (props.taken.includes(name))
      return setError(t(props.agents ? "settings.customNameTaken" : "settings.mcpNameTaken", name));
    if (draft.type === "stdio") {
      const command = draft.command.trim();
      if (!command) return setError(t("settings.mcpCommandRequired"));
      const env = parsePairs(draft.env);
      if (typeof env === "number") return setError(t("settings.mcpEnvInvalid", env));
      const args = draft.args.split(/\r?\n/).filter((l) => l.trim());
      return props.onSave(name, {
        command,
        ...(args.length ? { args } : {}),
        ...(Object.keys(env).length ? { env } : {}),
      });
    }
    const url = draft.url.trim();
    if (!isUrl(url)) return setError(t("settings.mcpUrlInvalid"));
    const headers = parsePairs(draft.headers, ":");
    if (typeof headers === "number") return setError(t("settings.mcpHeadersInvalid", headers));
    props.onSave(name, { type: draft.type, url, ...(Object.keys(headers).length ? { headers } : {}) });
  };

  return (
    <div className="mcp-editor">
      <div className="row">
        <Field id="mcp-name" label="settings.mcpName">
          <input
            id="mcp-name"
            type="text"
            spellCheck={false}
            placeholder={props.agents ? "my-agent" : "github"}
            value={draft.name}
            onChange={(e) => edit({ name: e.target.value })}
          />
        </Field>
        {!props.agents && (
          <Field id="mcp-type" label="settings.mcpType">
            <select id="mcp-type" value={draft.type} onChange={(e) => edit({ type: e.target.value as McpType })}>
              <option value="stdio">{t("settings.mcpTypeStdio")}</option>
              <option value="http">HTTP</option>
              <option value="sse">SSE</option>
            </select>
          </Field>
        )}
      </div>
      {draft.type === "stdio" ? (
        <>
          <Field id="mcp-command" label="settings.command">
            <input
              id="mcp-command"
              type="text"
              spellCheck={false}
              placeholder="npx"
              value={draft.command}
              onChange={(e) => edit({ command: e.target.value })}
            />
          </Field>
          <Field id="mcp-args" label="settings.args" desc="settings.argsDesc">
            <textarea
              id="mcp-args"
              rows={3}
              spellCheck={false}
              placeholder={props.agents ? "--acp" : "-y\n@modelcontextprotocol/server-github"}
              value={draft.args}
              onChange={(e) => edit({ args: e.target.value })}
            />
          </Field>
          <Field id="mcp-env" label="settings.env" desc="settings.mcpEnvDesc">
            <textarea
              id="mcp-env"
              rows={3}
              spellCheck={false}
              placeholder="KEY=VALUE"
              value={draft.env}
              onChange={(e) => edit({ env: e.target.value })}
            />
          </Field>
        </>
      ) : (
        <>
          <Field id="mcp-url" label="settings.mcpUrl" desc="settings.mcpRemoteNote">
            <input
              id="mcp-url"
              type="text"
              spellCheck={false}
              placeholder="https://example.com/mcp"
              value={draft.url}
              onChange={(e) => edit({ url: e.target.value })}
            />
          </Field>
          <Field id="mcp-headers" label="settings.mcpHeaders" desc="settings.mcpHeadersDesc">
            <textarea
              id="mcp-headers"
              rows={3}
              spellCheck={false}
              placeholder="Authorization: Bearer …"
              value={draft.headers}
              onChange={(e) => edit({ headers: e.target.value })}
            />
          </Field>
        </>
      )}
      {error && <div className="note error">{error}</div>}
      <div className="row">
        <button onClick={save}>{t("settings.mcpSave")}</button>
        <button className="secondary" onClick={props.onCancel}>
          {t("settings.mcpCancel")}
        </button>
      </div>
    </div>
  );
}

/** The entries of codeAcp.mcpServers or, with `agents`, of codeAcp.customAgents. */
export function EntryList(props: { agents?: boolean; value: unknown; overridden: boolean }) {
  const { t } = useL10n();
  const key = props.agents ? "customAgents" : "mcpServers";
  /** The entry being edited: its name, or "" for a new one. */
  const [editing, setEditing] = useState<string>();
  const servers = serversOf(props.value);
  const names = servers.map(([name]) => name);

  const save = (original: string, name: string, entry: McpServerEntry) => {
    // Keeps the server's place in the list when it is renamed.
    const next: Record<string, McpServerEntry> = {};
    for (const [key, value] of servers) next[key === original ? name : key] = key === original ? entry : value;
    if (!original) next[name] = entry;
    set(key, next);
    setEditing(undefined);
  };
  const remove = (name: string) => set(key, Object.fromEntries(servers.filter(([other]) => other !== name)));

  return (
    <>
      {props.overridden && <Overridden />}
      <div className="mcp-list">
        {!servers.length && editing === undefined && (
          <div className="note">{t(props.agents ? "settings.customEmpty" : "settings.mcpEmpty")}</div>
        )}
        {servers.map(([name, entry]) =>
          editing === name ? (
            <EntryEditor
              key={name}
              agents={props.agents}
              initial={toDraft(name, entry)}
              taken={names.filter((n) => n !== name)}
              onSave={(newName, newEntry) => save(name, newName, newEntry)}
              onCancel={() => setEditing(undefined)}
            />
          ) : (
            <div key={name} className="mcp-row">
              <span className="mcp-icon">
                <Icon svg={props.agents ? terminalIcon : "url" in entry ? worldIcon : serverIcon} />
              </span>
              <div className="mcp-info">
                <div>
                  <strong>{name}</strong>{" "}
                  {!props.agents && (
                    <span className="badge">{"url" in entry ? entry.type.toUpperCase() : "stdio"}</span>
                  )}
                </div>
                <code>{"url" in entry ? entry.url : [entry.command, ...(entry.args ?? [])].join(" ")}</code>
              </div>
              <button
                className="icon-btn"
                title={t("settings.mcpEdit")}
                aria-label={t("settings.mcpEdit")}
                disabled={editing !== undefined}
                onClick={() => setEditing(name)}
              >
                <Icon svg={pencilIcon} />
              </button>
              <button
                className="icon-btn danger"
                title={t("settings.mcpRemove")}
                aria-label={t("settings.mcpRemove")}
                disabled={editing !== undefined}
                onClick={() => remove(name)}
              >
                <Icon svg={trashIcon} />
              </button>
            </div>
          ),
        )}
        {editing === "" && (
          <EntryEditor
            agents={props.agents}
            initial={EMPTY_DRAFT}
            taken={names}
            onSave={(name, entry) => save("", name, entry)}
            onCancel={() => setEditing(undefined)}
          />
        )}
      </div>
      {editing === undefined && (
        <button className="with-icon" onClick={() => setEditing("")}>
          <Icon svg={plusIcon} />
          {t(props.agents ? "settings.customAdd" : "settings.mcpAdd")}
        </button>
      )}
      <div className="note muted">{t("settings.mcpSecretNote")}</div>
    </>
  );
}
