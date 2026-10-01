/** User stop, TTL and supersede retain the CLI's interruption leaf. */
import type { StartClaudeQueryParams } from "../src/query.ts";
import { deleteBridgesByConversation, stopConversationBridges } from "../src/bridge-pool.ts";
import { assert, assistant, bashTool, callTool, interruptibleTurn, mockHandle, result, startMockedProxy, textDelta, user } from "./helpers.ts";

async function main() {
  const h = await startMockedProxy("interrupted-leaf");
  const { getSessionLeafUuid } = await import("../src/session-store.ts");
  try {
    for (const mode of ["stop", "ttl", "supersede"]) {
      const log: string[] = [];
      const tool = mode !== "supersede";
      h.transcript(mode, ["tool", `${mode}-reject`, `${mode}-marker`]);
      let closed: Promise<void> = Promise.resolve();
      h.proxy.setClaudeQueryStarter(async (params) => {
        const turn = interruptibleTurn({ log, name: mode, sessionId: mode, body: async function* () {
          yield { type: "system", session_id: mode };
          yield { type: "assistant", uuid: "tool", session_id: mode };
          if (tool) void callTool(params);
          else yield textDelta("working");
          await new Promise(() => {});
        } });
        closed = turn.closed;
        return turn;
      });
      if (mode === "ttl") process.env.OPENCODE_CLAUDE_PARKED_TURN_TTL_MS = "10";
      const first = await h.post(mode, { stream: !tool, tools: tool ? [bashTool] : [], messages: [user("run")] });
      if (tool) await first.text();
      if (mode === "stop") deleteBridgesByConversation(mode);
      if (mode !== "supersede") {
        await closed;
        await stopConversationBridges(mode);
        assert.equal(getSessionLeafUuid(mode), `${mode}-marker`);
      }
      const calls: StartClaudeQueryParams[] = [];
      h.proxy.setClaudeQueryStarter(async (params) => {
        calls.push(params);
        return mockHandle((async function* () { yield textDelta("ok"); yield result; })());
      });
      const history = tool ? [user("run"), assistant("calling tool"),
        { role: "tool", tool_call_id: "old-call", content: "aborted" }, user("next")] : [user("run"), user("next")];
      const next = await h.post(mode, { messages: history });
      await next.text();
      if (!tool) await first.text();
      // The leaf follows the interruption entries: a plain resume, no fork.
      assert.equal(calls[0]?.resume, mode);
      assert.equal("resumeSessionAt" in calls[0]!, false);
      assert.deepEqual(h.forks, []);
      assert.deepEqual(log, [`${mode}:interrupt`, `${mode}:close`]);
      delete process.env.OPENCODE_CLAUDE_PARKED_TURN_TTL_MS;
    }
  } finally {
    delete process.env.OPENCODE_CLAUDE_PARKED_TURN_TTL_MS;
    await h.cleanup();
  }
  console.log("ok — interrupted leaf regression passed");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
