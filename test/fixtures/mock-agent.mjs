// A mock ACP agent speaking ndjson on stdio. Scenarios are picked by env vars and by the prompt text.
// The unstable entry: the stable API and session/fork.
import * as acp from "@agentclientprotocol/sdk/unstable";
import { Readable, Writable } from "node:stream";

if (process.env.MOCK_EXIT_EARLY === "1") {
  process.stderr.write("mock agent: boot failure\n");
  process.exit(3);
}

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));

acp
  .agent({ name: "mock-agent" })
  .onRequest(acp.methods.agent.initialize, ({ params }) => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentInfo: { name: "mock-agent", version: "9.9.9" },
    agentCapabilities: {
      mcpCapabilities: { http: process.env.MOCK_HTTP === "1", sse: false },
      ...(process.env.MOCK_FORK === "1" ? { sessionCapabilities: { fork: {} } } : {}),
    },
    authMethods: [{ id: "login", name: "Log in" }],
    _meta: { clientInfo: params.clientInfo, clientCapabilities: params.clientCapabilities, pid: process.pid },
  }))
  .onRequest(acp.methods.agent.session.new, ({ params }) => {
    if (process.env.MOCK_AUTH === "1") {
      throw acp.RequestError.authRequired();
    }
    return { sessionId: "s1", _meta: { cwd: params.cwd, mcpServers: params.mcpServers } };
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
      case "refuse":
        return { stopReason: "refusal" };
      case "pid":
        await say(String(process.pid));
        return { stopReason: "end_turn" };
      default:
        throw acp.RequestError.invalidParams(undefined, `unknown scenario ${scenario}`);
    }
  })
  .connect(stream);
