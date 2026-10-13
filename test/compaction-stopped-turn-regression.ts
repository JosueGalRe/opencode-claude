/**
 * Regression: OpenCode compacting a chat whose Claude turn is parked on a
 * tool call stops that turn, and the CLI records the pending call as
 * rejected by the user and the request as interrupted by the user. The
 * summary resumes the session after those entries, so it told the model
 * the user had rejected its calls. The summary prompt now says the stop
 * came from the plugin and relays the results OpenCode already has.
 * Ported from upstream 1.4.1.
 *
 * Run: bun test/compaction-stopped-turn-regression.ts
 */
import { REQUEST_KIND_HEADER } from "../src/constants.ts";
import type { StartClaudeQueryParams } from "../src/query.ts";
import { assert, bashTool, callTool, interruptibleTurn, mockHandle, promptText, startMockedProxy, textDelta, user } from "./helpers.ts";

const SUMMARY_PROMPT = "Summarize the conversation above using the template.";

async function main() {
  const h = await startMockedProxy("compaction-stopped");
  const log: string[] = [];
  let summary: StartClaudeQueryParams | null = null;
  h.proxy.setClaudeQueryStarter(async (params) => {
    if (params.persistSession === false) {
      summary = params;
      return mockHandle((async function* () {
        yield { type: "system", subtype: "init", session_id: "in-memory-fork" };
        yield textDelta("## Objective\n- the summary");
        yield { type: "result", is_error: false, usage: {}, session_id: "in-memory-fork" };
      })());
    }
    // The CLI writes the rejection and the interrupt marker after A1.
    h.append("stopped-sess", "A1", "turn-reject", "turn-marker");
    return interruptibleTurn({
      log,
      name: "turn",
      sessionId: "stopped-sess",
      body: async function* () {
        yield { type: "system", subtype: "init", session_id: "stopped-sess" };
        yield { type: "assistant", uuid: "A1", session_id: "stopped-sess", parent_tool_use_id: null, message: { content: [] } };
        await callTool(params);
      },
    });
  });

  try {
    const messages = [user("find the needle")];
    const first = (await (await h.post("chat", { tools: [bashTool], messages })).json()) as any;
    assert.equal(first.choices[0].finish_reason, "tool_calls");
    const call = first.choices[0].message.tool_calls[0];

    // OpenCode ran the call, then compacted before sending its result.
    const res = await h.post("chat", {
      tools: [bashTool],
      messages: [
        ...messages,
        { role: "assistant", content: null, tool_calls: [call] },
        { role: "tool", tool_call_id: call.id, content: "src/needle.ts:1" },
        user(SUMMARY_PROMPT),
      ],
    }, { [REQUEST_KIND_HEADER]: "compaction" });
    assert.equal(res.status, 200);
    assert.match(((await res.json()) as any).choices[0].message.content, /the summary/);
    assert.ok(log.includes("turn:interrupt"), "the parked turn was stopped");
    const params = summary as StartClaudeQueryParams | null;
    assert.ok(params, "summary ran");
    assert.equal(params!.resume, "stopped-sess");
    assert.equal(params!.resumeSessionAt, "turn-marker", "resumes after the rejection entries");
    const text = await promptText(params!.prompt);
    assert.ok(text.includes("<host_note>"), "the stop is attributed to the plugin");
    assert.ok(text.includes("nobody rejected anything"));
    assert.ok(text.includes("src/needle.ts:1"), "the result OpenCode has is relayed");
    assert.ok(text.includes(SUMMARY_PROMPT));
  } finally {
    await h.cleanup();
  }
  console.log("ok — compaction stopped turn regression passed");
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
