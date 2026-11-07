import type * as acp from "@agentclientprotocol/sdk";
import { NodeFileSystem } from "@effect/platform-node-shared";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Scope } from "effect";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AcpAgent,
  type AgentHandlers,
  canFork,
  canLogout,
  spawnAgent,
  type UrlElicitation,
} from "../src/acpClient";
import { __test, Uri, workspace } from "./stubs/vscode";
import { makeExtensionCtx, makeOutput, type OutputStub, stubLayer } from "./helpers";

const MOCK_AGENT = fileURLToPath(new URL("./fixtures/mock-agent.mjs", import.meta.url));

interface Recorder {
  readonly updates: Array<acp.SessionNotification>;
  readonly permissions: Array<acp.RequestPermissionRequest>;
  readonly elicitations: Array<acp.CreateElicitationRequest>;
  readonly written: Array<{ sessionId: string; path: string }>;
  readonly handlers: AgentHandlers;
}

const recorder = (pick: (req: acp.RequestPermissionRequest) => acp.RequestPermissionResponse): Recorder => {
  const updates: Array<acp.SessionNotification> = [];
  const permissions: Array<acp.RequestPermissionRequest> = [];
  const elicitations: Array<acp.CreateElicitationRequest> = [];
  const written: Array<{ sessionId: string; path: string }> = [];
  return {
    updates,
    permissions,
    elicitations,
    written,
    handlers: {
      onUpdate: (n) => void updates.push(n),
      requestPermission: (req) => {
        permissions.push(req);
        return Effect.succeed(pick(req));
      },
      onFileWritten: (sessionId, p) => void written.push({ sessionId, path: p }),
    },
  };
};

const allow = recorder(() => ({ outcome: { outcome: "selected", optionId: "allow" } }));

const spawn = (env: Record<string, string>, handlers: AgentHandlers) =>
  spawnAgent(
    { command: process.execPath, args: [MOCK_AGENT], env: { ...process.env, ...env } as Record<string, string> },
    handlers,
  );

const messageText = (rec: Recorder) =>
  rec.updates
    .map((u) =>
      u.update.sessionUpdate === "agent_message_chunk" && u.update.content.type === "text" ? u.update.content.text : "",
    )
    .join("");

const text = (value: string): Array<acp.ContentBlock> => [{ type: "text", text: value }];

/** Runs `body` with an agent spawned in a Scope that closes afterwards. */
const withAgent = <A, E>(
  env: Record<string, string>,
  rec: Recorder,
  body: (agent: AcpAgent, output: OutputStub) => Effect.Effect<A, E, Scope.Scope | FileSystem.FileSystem>,
) => {
  const output = makeOutput();
  return Effect.gen(function* () {
    const agent = yield* spawn(env, rec.handlers);
    return yield* body(agent, output);
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(stubLayer(output), NodeFileSystem.layer)));
};

const prompt = (agent: AcpAgent, value: string) => agent.prompt("s1", text(value));

describe("spawnAgent", () => {
  it.live("logs the messages exchanged with the agent while tracing is on", () =>
    Effect.gen(function* () {
      __test.setSetting("codeAcp.tracing", true);
      yield* withAgent({}, allow, (agent) =>
        Effect.gen(function* () {
          yield* prompt(agent, "updates");
          const lines = __test.outputChannels.get("Code ACP Trace") ?? [];
          assert.isTrue(lines.some((line) => line.includes(" → ") && line.includes('"initialize"')));
          assert.isTrue(lines.some((line) => line.includes(" ← ") && line.includes('"end_turn"')));
          assert.isTrue(lines.some((line) => line.includes(" ← ×2 ") && line.includes("hello world")));
          assert.match(lines[0]!, /\[node#\d+\]/);
        }),
      );
    }),
  );

  it.live("keeps no log while tracing is off", () =>
    Effect.gen(function* () {
      __test.reset();
      yield* withAgent({}, allow, (agent) => prompt(agent, "updates"));
      assert.isFalse(__test.outputChannels.has("Code ACP Trace"));
    }),
  );

  it.live("completes the initialize handshake and reports capabilities", () => {
    const rec = recorder(() => ({ outcome: { outcome: "cancelled" } }));
    return withAgent({ MOCK_HTTP: "1" }, rec, (agent) =>
      Effect.sync(() => {
        const init = agent.initializeResponse;
        assert.strictEqual(init.agentInfo?.name, "mock-agent");
        assert.strictEqual(init.agentCapabilities?.mcpCapabilities?.http, true);
        assert.deepStrictEqual(
          agent.authMethods.map((m) => m.id),
          ["login"],
        );
        // The mock echoes what the client announced.
        const meta = init._meta as {
          clientInfo: { name: string; version: string };
          clientCapabilities: acp.ClientCapabilities;
        };
        assert.deepStrictEqual(meta.clientInfo, { name: "code-acp", version: "1.2.3" });
        assert.deepStrictEqual(meta.clientCapabilities.fs, { readTextFile: true, writeTextFile: true });
        assert.deepStrictEqual(meta.clientCapabilities.session, { notices: {}, compaction: {} });
        // No onTerminal handler: no terminal capability; no elicit handler: no elicitations.
        assert.strictEqual(meta.clientCapabilities.terminal, false);
        assert.isUndefined(meta.clientCapabilities.elicitation);
      }),
    );
  });

  it.live("announces the terminal capability when onTerminal is given", () => {
    const output = makeOutput();
    return Effect.gen(function* () {
      const agent = yield* spawn({}, { ...allow.handlers, onTerminal: () => {} });
      const meta = agent.initializeResponse._meta as { clientCapabilities: acp.ClientCapabilities };
      assert.strictEqual(meta.clientCapabilities.terminal, true);
    }).pipe(Effect.scoped, Effect.provide(stubLayer(output)));
  });

  it.live("falls back to version 0.0.0 without a package version", () => {
    const output = makeOutput();
    return Effect.gen(function* () {
      const agent = yield* spawn({}, allow.handlers);
      const meta = agent.initializeResponse._meta as { clientInfo: { version: string } };
      assert.strictEqual(meta.clientInfo.version, "0.0.0");
    }).pipe(Effect.scoped, Effect.provide(stubLayer(output, makeExtensionCtx("/tmp/x", {}))));
  });

  it.live("newSession passes cwd and mcpServers through", () => {
    __test.reset();
    __test.setSetting("codeAcp.mcpServers", {
      local: { command: "node", args: ["srv.js"], env: { K: "v" } },
      remote: { type: "http", url: "https://example.test/mcp" },
    });
    return withAgent({}, allow, (agent) =>
      Effect.gen(function* () {
        const res = yield* agent.newSession("/some/cwd");
        assert.strictEqual(res.sessionId, "s1");
        const meta = res._meta as { cwd: string; mcpServers: Array<unknown> };
        assert.strictEqual(meta.cwd, "/some/cwd");
        // The mock agent does not advertise http support, so only the stdio server is passed.
        assert.deepStrictEqual(meta.mcpServers, [
          { name: "local", command: "node", args: ["srv.js"], env: [{ name: "K", value: "v" }] },
        ]);
      }),
    );
  });

  it.live("forks a session when the agent advertises session/fork", () => {
    __test.reset();
    __test.setSetting("codeAcp.mcpServers", { local: { command: "node", args: ["srv.js"] } });
    return Effect.gen(function* () {
      yield* withAgent({}, allow, (agent) => Effect.sync(() => assert.isFalse(canFork(agent))));
      yield* withAgent({ MOCK_FORK: "1" }, allow, (agent) =>
        Effect.gen(function* () {
          assert.isTrue(canFork(agent));
          const res = yield* agent.forkSession("s1", "/some/cwd");
          assert.strictEqual(res.sessionId, "s1-fork");
          const meta = res._meta as { cwd: string; mcpServers: Array<unknown> };
          assert.strictEqual(meta.cwd, "/some/cwd");
          assert.deepStrictEqual(meta.mcpServers, [{ name: "local", command: "node", args: ["srv.js"], env: [] }]);
        }),
      );
    });
  });

  it.live("newSession passes http servers when the agent supports them", () => {
    __test.reset();
    __test.setSetting("codeAcp.mcpServers", { remote: { type: "http", url: "https://example.test/mcp" } });
    return withAgent({ MOCK_HTTP: "1" }, allow, (agent) =>
      Effect.gen(function* () {
        const res = yield* agent.newSession("/c");
        const meta = res._meta as { mcpServers: unknown };
        assert.deepStrictEqual(meta.mcpServers, [
          { type: "http", name: "remote", url: "https://example.test/mcp", headers: [] },
        ]);
      }),
    );
  });

  it.live("delivers session updates to onUpdate and returns the stop reason", () => {
    const rec = recorder(() => ({ outcome: { outcome: "cancelled" } }));
    return withAgent({}, rec, (agent) =>
      Effect.gen(function* () {
        yield* agent.newSession("/c");
        const res = yield* prompt(agent, "updates");
        assert.strictEqual(res.stopReason, "end_turn");
        // Notifications are handled before the prompt response is delivered.
        assert.strictEqual(rec.updates.length, 2);
        assert.strictEqual(rec.updates[0]!.sessionId, "s1");
        assert.strictEqual(messageText(rec), "hello world");
        const refused = yield* prompt(agent, "refuse");
        assert.strictEqual(refused.stopReason, "refusal");
      }),
    );
  });

  it.live("round-trips permission requests through the handler", () => {
    const rec = recorder(() => ({ outcome: { outcome: "selected", optionId: "deny" } }));
    return withAgent({}, rec, (agent) =>
      Effect.gen(function* () {
        yield* prompt(agent, "permission");
        assert.strictEqual(rec.permissions.length, 1);
        assert.strictEqual(rec.permissions[0]!.toolCall.toolCallId, "t1");
        assert.deepStrictEqual(
          rec.permissions[0]!.options.map((o) => o.optionId),
          ["allow", "deny"],
        );
        assert.deepStrictEqual(JSON.parse(messageText(rec)), { outcome: "selected", optionId: "deny" });
      }),
    );
  });

  it.live("offers elicitations and round-trips them through the handler", () => {
    const rec = recorder(() => ({ outcome: { outcome: "cancelled" } }));
    const handlers: AgentHandlers = {
      ...rec.handlers,
      elicit: (req) => {
        rec.elicitations.push(req);
        return Effect.succeed({ action: "accept", content: { question_0_custom: "neither" } });
      },
    };
    return withAgent({}, { ...rec, handlers }, (agent) =>
      Effect.gen(function* () {
        const meta = agent.initializeResponse._meta as { clientCapabilities: acp.ClientCapabilities };
        assert.deepStrictEqual(meta.clientCapabilities.elicitation, { form: {}, url: {} });
        yield* prompt(agent, "elicit");
        assert.strictEqual(rec.elicitations.length, 1);
        assert.strictEqual(rec.elicitations[0]!.message, "Which one?");
        assert.deepStrictEqual(JSON.parse(messageText(rec)), {
          action: "accept",
          content: { question_0_custom: "neither" },
        });
        // A mode the client doesn't know is cancelled without asking the user.
        rec.updates.length = 0;
        yield* prompt(agent, "elicit future");
        assert.strictEqual(rec.elicitations.length, 1);
        assert.deepStrictEqual(JSON.parse(messageText(rec)), { action: "cancel" });
      }),
    );
  });

  it.live("asks about URL elicitations and reports when they complete", () => {
    const rec = recorder(() => ({ outcome: { outcome: "cancelled" } }));
    const completed: string[] = [];
    const handlers: AgentHandlers = {
      ...rec.handlers,
      elicit: (req) => {
        rec.elicitations.push(req);
        return Effect.succeed({ action: "accept" });
      },
      onElicitationComplete: (id) => void completed.push(id),
    };
    return withAgent({}, { ...rec, handlers }, (agent) =>
      Effect.gen(function* () {
        yield* prompt(agent, "elicit url");
        const asked = rec.elicitations[0] as UrlElicitation;
        assert.strictEqual(asked.mode, "url");
        assert.strictEqual(asked.url, "https://example.com/login?next=a%26b");
        assert.deepStrictEqual(JSON.parse(messageText(rec)), { action: "accept" });
        // Sent before the prompt's answer, but not ordered with it.
        yield* Effect.gen(function* () {
          for (let waited = 0; completed.length === 0 && waited < 1000; waited++) {
            yield* Effect.sleep("2 millis");
          }
        });
        assert.deepStrictEqual(completed, ["e1"]);
      }),
    );
  });

  it.live("shows the modes of an agent without config options as an option, and sets them", () => {
    const rec = recorder(() => ({ outcome: { outcome: "cancelled" } }));
    return withAgent({ MOCK_MODES: "1" }, rec, (agent) =>
      Effect.gen(function* () {
        const { sessionId, configOptions } = yield* agent.newSession(process.cwd());
        const option = configOptions![0] as acp.SessionConfigOption & { type: "select" };
        assert.strictEqual(option.category, "mode");
        assert.strictEqual(option.currentValue, "ask");
        assert.deepStrictEqual(
          option.options.map((o) => ("value" in o ? o.value : "")),
          ["ask", "code"],
        );

        const set = yield* agent.setConfigOption(sessionId, option.id, "code");
        assert.strictEqual((set.configOptions[0] as typeof option).currentValue, "code");
        yield* agent.prompt(sessionId, [{ type: "text", text: "mode" }]);
        assert.strictEqual(messageText(rec), "code");

        // The agent switching by itself looks like the option changing.
        rec.updates.length = 0;
        yield* agent.prompt(sessionId, [{ type: "text", text: "mode ask" }]);
        const update = rec.updates.at(-1)!.update;
        assert.strictEqual(update.sessionUpdate, "config_option_update");
        assert.strictEqual(
          update.sessionUpdate === "config_option_update" && (update.configOptions[0] as typeof option).currentValue,
          "ask",
        );
      }),
    );
  });

  it.live("prefers config options over modes", () => {
    const rec = recorder(() => ({ outcome: { outcome: "cancelled" } }));
    return withAgent({ MOCK_MODES: "both" }, rec, (agent) =>
      Effect.gen(function* () {
        const { sessionId, configOptions } = yield* agent.newSession(process.cwd());
        assert.deepStrictEqual(
          configOptions?.map((o) => o.id),
          ["real"],
        );
        yield* agent.prompt(sessionId, [{ type: "text", text: "mode code" }]);
        assert.strictEqual(rec.updates.at(-1)!.update.sessionUpdate, "current_mode_update");
      }),
    );
  });

  it.live("deletes sessions and logs out when the agent can", () => {
    const rec = recorder(() => ({ outcome: { outcome: "cancelled" } }));
    return withAgent({ MOCK_HISTORY: "1", MOCK_LOGOUT: "1" }, rec, (agent) =>
      Effect.gen(function* () {
        assert.isTrue(canLogout(agent));
        yield* agent.deleteSession("old");
        assert.deepStrictEqual((yield* agent.listSessions(process.cwd())).sessions, []);
        const again = yield* Effect.flip(agent.deleteSession("old"));
        assert.strictEqual(again._tag, "AgentRequestError");
        yield* agent.logout;
      }),
    );
  });

  it.live("passes compaction updates on", () => {
    const rec = recorder(() => ({ outcome: { outcome: "cancelled" } }));
    return withAgent({}, rec, (agent) =>
      Effect.gen(function* () {
        assert.isFalse(canLogout(agent));
        yield* prompt(agent, "compact");
        assert.deepStrictEqual(
          rec.updates.map((u) => u.update.sessionUpdate),
          ["compaction_update", "compaction_summary_chunk", "compaction_summary_chunk", "compaction_update"],
        );
      }),
    );
  });

  it.live("serves fs/read_text_file, including line and limit", () => {
    const rec = recorder(() => ({ outcome: { outcome: "cancelled" } }));
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const file = path.join(dir, "a.txt");
      yield* fs.writeFileString(file, "one\ntwo\nthree\nfour");
      yield* withAgent({}, rec, (agent) => prompt(agent, `read ${file}`));
      assert.strictEqual(messageText(rec), "one\ntwo\nthree\nfour");
      rec.updates.length = 0;
      yield* withAgent({ MOCK_LINE: "2", MOCK_LIMIT: "2" }, rec, (agent) => prompt(agent, `read ${file}`));
      assert.strictEqual(messageText(rec), "two\nthree");
      rec.updates.length = 0;
      yield* withAgent({ MOCK_LINE: "3" }, rec, (agent) => prompt(agent, `read ${file}`));
      assert.strictEqual(messageText(rec), "three\nfour");
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer));
  });

  it.live("reads closed files from disk without opening them", () => {
    __test.reset();
    const rec = recorder(() => ({ outcome: { outcome: "cancelled" } }));
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const file = path.join(dir, "closed.txt");
      yield* fs.writeFileString(file, "on disk");
      yield* withAgent({}, rec, (agent) => prompt(agent, `read ${file}`));
      assert.strictEqual(messageText(rec), "on disk");
      assert.deepStrictEqual(__test.openedDocuments, []);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer));
  });

  it.live("reads open files from the editor buffer, with unsaved changes", () => {
    __test.reset();
    const rec = recorder(() => ({ outcome: { outcome: "cancelled" } }));
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const file = path.join(dir, "open.txt");
      yield* fs.writeFileString(file, "on disk");
      workspace.textDocuments = [
        { uri: Uri.file(file), isClosed: false, lineCount: 1, save: async () => true, getText: () => "unsaved\nlines" },
      ];
      yield* withAgent({ MOCK_LINE: "2" }, rec, (agent) => prompt(agent, `read ${file}`));
      assert.strictEqual(messageText(rec), "lines");
      assert.deepStrictEqual(__test.openedDocuments, []);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer), Effect.ensuring(Effect.sync(() => __test.reset())));
  });

  it.live("passes session notices on", () => {
    const rec = recorder(() => ({ outcome: { outcome: "cancelled" } }));
    return withAgent({}, rec, (agent) =>
      Effect.gen(function* () {
        yield* prompt(agent, "notice");
        assert.deepStrictEqual(
          rec.updates.map((u) => u.update),
          [{ sessionUpdate: "notice", severity: "warning", title: "Slow down", description: "Rate limited" }],
        );
      }),
    );
  });

  it.live("announces async tasks only when onAsyncTask is given", () => {
    const capabilities = (agent: AcpAgent) =>
      (agent.initializeResponse._meta as { clientCapabilities: acp.ClientCapabilities }).clientCapabilities;
    return Effect.gen(function* () {
      yield* withAgent({}, allow, (agent) => Effect.sync(() => assert.isUndefined(capabilities(agent)._meta)));
      const rec = recorder(() => ({ outcome: { outcome: "cancelled" } }));
      yield* withAgent({}, { ...rec, handlers: { ...rec.handlers, onAsyncTask: () => {} } }, (agent) =>
        Effect.sync(() =>
          assert.deepStrictEqual(capabilities(agent)._meta, {
            jetbrains: { air: { version: 1, capabilities: ["asyncTasks"] } },
          }),
        ),
      );
    });
  });

  it.live("takes async task updates off the session updates, and stops a task", () => {
    const rec = recorder(() => ({ outcome: { outcome: "cancelled" } }));
    const tasks: Array<{ sessionId: string; update: unknown }> = [];
    const handlers: AgentHandlers = {
      ...rec.handlers,
      onAsyncTask: (sessionId, update) => void tasks.push({ sessionId, update }),
    };
    return withAgent({}, { ...rec, handlers }, (agent) =>
      Effect.gen(function* () {
        yield* prompt(agent, "background");
        // The update of a later version is dropped: the SDK would fail on it.
        assert.strictEqual(messageText(rec), "started");
        assert.deepStrictEqual(
          rec.updates.map((u) => u.update.sessionUpdate),
          ["agent_message_chunk"],
        );
        assert.deepStrictEqual(tasks, [
          {
            sessionId: "s1",
            update: {
              sessionUpdate: "async_task_spawned",
              asyncTaskId: "t1",
              name: "Bash",
              taskType: "shell",
              description: "sleep 60",
              canStop: true,
              toolCallId: "call1",
            },
          },
          { sessionId: "s1", update: { sessionUpdate: "async_task_progress", asyncTaskId: "t1", summary: "tick 1" } },
        ]);
        yield* agent.stopAsyncTask("s1", "t1");
        assert.deepStrictEqual(tasks.at(-1), {
          sessionId: "s1",
          update: { sessionUpdate: "async_task_state_update", asyncTaskId: "t1", state: "stopped" },
        });
      }),
    );
  });

  it.live("answers a read of a missing file with an error to the agent", () => {
    const rec = recorder(() => ({ outcome: { outcome: "cancelled" } }));
    return withAgent({}, rec, (agent) =>
      Effect.gen(function* () {
        const res = yield* prompt(agent, "readMissing /definitely/not/here.txt");
        assert.strictEqual(res.stopReason, "end_turn");
        assert.match(messageText(rec), /^error:/);
      }),
    );
  });

  it.live("serves fs/write_text_file and calls onFileWritten", () => {
    __test.reset();
    const rec = recorder(() => ({ outcome: { outcome: "cancelled" } }));
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const file = path.join(dir, "nested", "out.txt");
      yield* withAgent({}, rec, (agent) => prompt(agent, `write ${file}`));
      assert.strictEqual(yield* fs.readFileString(file), "written by agent");
      assert.deepStrictEqual(rec.written, [{ sessionId: "s1", path: file }]);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer));
  });

  it.live("maps an auth-required agent error to AuthRequiredError", () =>
    withAgent({ MOCK_AUTH: "1" }, allow, (agent) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(agent.newSession("/c"));
        assert.strictEqual(error._tag, "AuthRequiredError");
      }),
    ),
  );

  it.live("maps other agent errors to AgentRequestError", () =>
    withAgent({}, allow, (agent) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(prompt(agent, "bogus"));
        assert.strictEqual(error._tag, "AgentRequestError");
        if (error._tag === "AgentRequestError") {
          assert.strictEqual(error.method, "session/prompt");
        }
      }),
    ),
  );

  it.live("fails with AgentStartError when the agent exits during initialize", () => {
    const output = makeOutput();
    return Effect.gen(function* () {
      const error = yield* Effect.flip(spawn({ MOCK_EXIT_EARLY: "1" }, allow.handlers));
      assert.strictEqual(error._tag, "AgentStartError");
      // stderr of the agent reaches the output channel
      assert.isTrue(output.lines.some((l) => l.includes("boot failure")));
    }).pipe(Effect.scoped, Effect.provide(stubLayer(output)));
  });

  it.live("fails with AgentStartError when the command does not exist", () => {
    const output = makeOutput();
    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        spawnAgent({ command: "definitely-not-a-command-xyz", args: [], env: {} }, allow.handlers),
      );
      assert.strictEqual(error._tag, "AgentStartError");
    }).pipe(Effect.scoped, Effect.provide(stubLayer(output)));
  });

  it.live("kills the agent process when the Scope closes", () =>
    Effect.gen(function* () {
      const rec = recorder(() => ({ outcome: { outcome: "cancelled" } }));
      const scope = yield* Scope.make();
      const output = makeOutput();
      const agent = yield* spawn({}, rec.handlers).pipe(Scope.provide(scope), Effect.provide(stubLayer(output)));
      yield* prompt(agent, "pid");
      const pid = Number(messageText(rec));
      assert.isAbove(pid, 0);
      assert.notStrictEqual(pid, process.pid);
      process.kill(pid, 0); // alive: would throw otherwise
      yield* Scope.close(scope, { _tag: "Success", value: undefined } as never);
      yield* Effect.promise(async () => {
        for (let i = 0; i < 100; i++) {
          try {
            process.kill(pid, 0);
          } catch {
            return;
          }
          await new Promise((r) => setTimeout(r, 50));
        }
        throw new Error(`process ${pid} still alive`);
      });
    }),
  );
});
