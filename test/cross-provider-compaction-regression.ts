/**
 * A chat compacted by another provider's model never reaches the summary
 * route, so the turn parked on the old history must be stopped by the next
 * request instead of re-emitting its calls. The fork already covered this
 * (findParkedBridge checks the history before reusing a parked turn); this
 * pins upstream's scenario (4385fc5, #57).
 *
 * Run: bun test/cross-provider-compaction-regression.ts
 */
import { assert, bashTool, callTool, interruptibleTurn, startMockedProxy, textDelta } from "./helpers.ts";

async function main() {
  const h = await startMockedProxy("cross-provider-compaction");
  const log: string[] = [];
  let spawns = 0;
  try {
    h.proxy.setClaudeQueryStarter(async (params) => {
      const turn = ++spawns;
      if (turn > 1) {
        assert.equal(params.resume, undefined, "compacted history must not resume the old Claude session");
      }
      return interruptibleTurn({
        log,
        name: `turn-${turn}`,
        sessionId: `claude-${turn}`,
        body: async function* () {
          yield { type: "system", subtype: "init", session_id: `claude-${turn}` };
          await callTool(params);
          yield textDelta("continued from current history");
          yield { type: "result", is_error: false, usage: { input_tokens: 1000, output_tokens: 10 } };
        },
      });
    });
    const first = await h.post("cross-provider", {
      tools: [bashTool], messages: [{ role: "user", content: "original long conversation" }],
    });
    const old = (await first.json()) as any;
    assert.equal(old.choices[0].finish_reason, "tool_calls");

    // Another provider completed the compaction: the next request holds only
    // its checkpoint, and the pending old call is text in recent-context.
    const checkpoint = [{ role: "user", content: "<conversation-checkpoint>\n<summary>Continue current work</summary>\n<recent-context>old-work finished</recent-context>\n</conversation-checkpoint>" }];
    const fresh = (await (await h.post("cross-provider", { tools: [bashTool], messages: checkpoint })).json()) as any;
    assert.equal(spawns, 2, "the checkpoint replaces the parked turn, not re-emits its old call");
    assert.ok(log.includes("turn-1:interrupt"), "old process stopped before replacing its binding");
    const call = fresh.choices[0].message.tool_calls[0];
    assert.notEqual(call.id, old.choices[0].message.tool_calls[0].id);

    // Retrying an unchanged checkpoint reuses the new park.
    const retry = (await (await h.post("cross-provider", { tools: [bashTool], messages: checkpoint })).json()) as any;
    assert.equal(retry.choices[0].message.tool_calls[0].id, call.id);
    assert.equal(spawns, 2);
    const continued = (await (await h.post("cross-provider", {
      tools: [bashTool], messages: [
        ...checkpoint,
        { role: "assistant", content: null, tool_calls: [call] },
        { role: "tool", tool_call_id: call.id, content: "done" },
      ],
    })).json()) as any;
    assert.equal(continued.choices[0].finish_reason, "stop");
    assert.equal(spawns, 2, "a tool continuation after the checkpoint stays on the same turn");
  } finally {
    await h.cleanup();
  }
  console.log("ok — cross-provider compaction regression passed");
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
