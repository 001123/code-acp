// Smoke test: spawn an ACP agent, initialize, create a session, optionally send a prompt.
// Usage: node scripts/smoke.mjs [--prompt "text"] -- <agent command> [args...]
import * as acp from "@agentclientprotocol/sdk";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
if (sep < 0 || sep === argv.length - 1) {
  console.error('Usage: node scripts/smoke.mjs [--prompt "text"] -- <agent command> [args...]');
  process.exit(1);
}
const promptIdx = argv.indexOf("--prompt");
const promptText = promptIdx >= 0 && promptIdx < sep ? argv[promptIdx + 1] : undefined;
const [command, ...args] = argv.slice(sep + 1);

const child = spawn(command, args, {
  stdio: ["pipe", "pipe", "inherit"],
});
const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
const conn = acp
  .client({ name: "smoke" })
  .onNotification(acp.methods.client.session.update, ({ params }) => {
    const u = params.update;
    if (u.sessionUpdate === "agent_message_chunk") process.stdout.write(u.content.text ?? "");
    else console.log(`\n[update] ${u.sessionUpdate}`);
  })
  .onRequest(acp.methods.client.session.requestPermission, ({ params }) => ({
    outcome: { outcome: "selected", optionId: params.options[0].optionId },
  }))
  .connect(stream);

try {
  const init = await conn.agent.request(acp.methods.agent.initialize, {
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: { auth: { terminal: true } },
  });
  console.log("agent:", init.agentInfo, "auth:", init.authMethods.map((m) => m.id));
  const session = await conn.agent.request(acp.methods.agent.session.new, { cwd: process.cwd(), mcpServers: [] });
  console.log("session:", session.sessionId, "config:", session.configOptions?.map((o) => o.id));
  if (promptText) {
    const res = await conn.agent.request(acp.methods.agent.session.prompt, {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: promptText }],
    });
    console.log("\nstop:", res.stopReason);
  }
} catch (err) {
  console.error("error:", err.code, err.message);
} finally {
  conn.close();
  child.kill();
}
