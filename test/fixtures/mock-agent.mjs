// A mock ACP agent speaking ndjson on stdio. Scenarios are picked by env vars and by the prompt text.
// The unstable entry: the stable API and session/fork.
import * as acp from "@agentclientprotocol/sdk/unstable";
import { Readable, Writable } from "node:stream";

if (process.env.MOCK_EXIT_EARLY === "1") {
  process.stderr.write("mock agent: boot failure\n");
  process.exit(3);
}

let sessions = 0;

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));

acp
  .agent({ name: "mock-agent" })
  .onRequest(acp.methods.agent.initialize, ({ params }) => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentInfo: { name: "mock-agent", version: "9.9.9" },
    agentCapabilities: {
      mcpCapabilities: { http: process.env.MOCK_HTTP === "1", sse: false },
      loadSession: process.env.MOCK_LOAD === "1",
      ...(process.env.MOCK_FORK === "1" ? { sessionCapabilities: { fork: {} } } : {}),
    },
    authMethods: [process.env.MOCK_TERMINAL_AUTH === "1" ? { id: "login", name: "Log in", type: "terminal", args: ["--login"] } : { id: "login", name: "Log in" }],
    _meta: { clientInfo: params.clientInfo, clientCapabilities: params.clientCapabilities, pid: process.pid },
  }))
  .onRequest(acp.methods.agent.session.new, ({ params }) => {
    if (process.env.MOCK_AUTH === "1") {
      throw acp.RequestError.authRequired();
    }
    return { sessionId: `s${++sessions}`, _meta: { cwd: params.cwd, mcpServers: params.mcpServers } };
  })
  .onRequest(acp.methods.agent.session.load, async ({ params, client }) => {
    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `replayed ${params.sessionId}` } },
    });
    return {};
  })
  .onRequest(acp.methods.agent.session.fork, ({ params }) => ({
    sessionId: `${params.sessionId}-fork`,
    _meta: { cwd: params.cwd, mcpServers: params.mcpServers },
  }))
  .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
    const text = params.prompt.map((b) => (b.type === "text" ? b.text : "")).join("");
    const [scenario, arg] = text.split(" ");
    const say = (message) =>
      client.notify(acp.methods.client.session.update, {
        sessionId: params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: message } },
      });
    switch (scenario) {
      case "updates":
        await say("hello ");
        await say("world");
        return { stopReason: "end_turn" };
      case "permission": {
        const res = await client.request(acp.methods.client.session.requestPermission, {
          sessionId: params.sessionId,
          toolCall: { toolCallId: "t1", title: "Run it" },
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "deny", name: "Deny", kind: "reject_once" },
          ],
        });
        await say(JSON.stringify(res.outcome));
        return { stopReason: "end_turn" };
      }
      case "elicit": {
        const res = await client.request(acp.methods.client.elicitation.create, {
          sessionId: params.sessionId,
          toolCallId: "t1",
          mode: arg === "url" ? "url" : "form",
          message: "Which one?",
          ...(arg === "url"
            ? { elicitationId: "e1", url: "https://example.com/login" }
            : {
                requestedSchema: {
                  type: "object",
                  properties: {
                    question_0: { type: "string", oneOf: [{ const: "a", title: "A" }, { const: "b", title: "B" }] },
                    question_0_custom: { type: "string", title: "Other" },
                  },
                },
              }),
        });
        await say(JSON.stringify(res));
        return { stopReason: "end_turn" };
      }
      case "read": {
        const res = await client.request(acp.methods.client.fs.readTextFile, {
          sessionId: params.sessionId,
          path: arg,
          line: process.env.MOCK_LINE ? Number(process.env.MOCK_LINE) : undefined,
          limit: process.env.MOCK_LIMIT ? Number(process.env.MOCK_LIMIT) : undefined,
        });
        await say(res.content);
        return { stopReason: "end_turn" };
      }
      case "write":
        await client.request(acp.methods.client.fs.writeTextFile, {
          sessionId: params.sessionId,
          path: arg,
          content: "written by agent",
        });
        return { stopReason: "end_turn" };
      case "readMissing":
        try {
          await client.request(acp.methods.client.fs.readTextFile, { sessionId: params.sessionId, path: arg });
          await say("unexpected success");
        } catch (e) {
          await say(`error:${e.code}`);
        }
        return { stopReason: "end_turn" };
      case "notice":
        await client.notify(acp.methods.client.session.update, {
          sessionId: params.sessionId,
          update: { sessionUpdate: "notice", severity: "warning", title: "Slow down", description: "Rate limited" },
        });
        return { stopReason: "end_turn" };
      case "refuse":
        return { stopReason: "refusal" };
      case "expired":
        throw acp.RequestError.authRequired();
      case "pid":
        await say(String(process.pid));
        return { stopReason: "end_turn" };
      default:
        throw acp.RequestError.invalidParams(undefined, `unknown scenario ${scenario}`);
    }
  })
  .connect(stream);
