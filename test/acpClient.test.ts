import type * as acp from "@agentclientprotocol/sdk";
import { NodeFileSystem } from "@effect/platform-node-shared";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Scope } from "effect";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { type AcpAgent, type AgentHandlers, canFork, spawnAgent } from "../src/acpClient";
import { ExtensionCtx, Output } from "../src/runtime";
import { __test } from "./stubs/vscode";
import { makeExtensionCtx, makeOutput, type OutputStub, stubLayer } from "./helpers";

const MOCK_AGENT = fileURLToPath(new URL("./fixtures/mock-agent.mjs", import.meta.url));

interface Recorder {
  readonly updates: Array<acp.SessionNotification>;
  readonly permissions: Array<acp.RequestPermissionRequest>;
  readonly written: Array<{ sessionId: string; path: string }>;
  readonly handlers: AgentHandlers;
}

const recorder = (pick: (req: acp.RequestPermissionRequest) => acp.RequestPermissionResponse): Recorder => {
  const updates: Array<acp.SessionNotification> = [];
  const permissions: Array<acp.RequestPermissionRequest> = [];
  const written: Array<{ sessionId: string; path: string }> = [];
  return {
    updates,
    permissions,
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
  spawnAgent({ command: process.execPath, args: [MOCK_AGENT], env: { ...process.env, ...env } as Record<string, string> }, handlers);

const messageText = (rec: Recorder) =>
  rec.updates
    .map((u) => (u.update.sessionUpdate === "agent_message_chunk" && u.update.content.type === "text" ? u.update.content.text : ""))
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
  it.live("completes the initialize handshake and reports capabilities", () => {
    const rec = recorder(() => ({ outcome: { outcome: "cancelled" } }));
    return withAgent({ MOCK_HTTP: "1" }, rec, (agent) =>
      Effect.sync(() => {
        const init = agent.initializeResponse;
        assert.strictEqual(init.agentInfo?.name, "mock-agent");
        assert.strictEqual(init.agentCapabilities?.mcpCapabilities?.http, true);
        assert.deepStrictEqual(agent.authMethods.map((m) => m.id), ["login"]);
        // The mock echoes what the client announced.
        const meta = init._meta as { clientInfo: { name: string; version: string }; clientCapabilities: acp.ClientCapabilities };
        assert.deepStrictEqual(meta.clientInfo, { name: "code-acp", version: "1.2.3" });
        assert.deepStrictEqual(meta.clientCapabilities.fs, { readTextFile: true, writeTextFile: true });
        // No onTerminal handler: no terminal capability.
        assert.strictEqual(meta.clientCapabilities.terminal, false);
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
    }).pipe(
      Effect.scoped,
      Effect.provideService(Output, output),
      Effect.provideService(ExtensionCtx, makeExtensionCtx("/tmp/x", {})),
    );
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
        assert.deepStrictEqual(rec.permissions[0]!.options.map((o) => o.optionId), ["allow", "deny"]);
        assert.deepStrictEqual(JSON.parse(messageText(rec)), { outcome: "selected", optionId: "deny" });
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
