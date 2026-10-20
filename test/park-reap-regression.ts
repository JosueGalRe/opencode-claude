/**
 * Regression: parked turns must not leak their Claude Code process.
 * - A turn parked only on StructuredOutput is never resumed by OpenCode (it
 *   treats the call as terminal), so it is reaped after a short grace period.
 * - A turn parked on regular tools stays parked, but only up to the
 *   parked-turn TTL (OPENCODE_CLAUDE_PARKED_TURN_TTL_MS).
 * - Results that arrive after the reap rebuild the turn around them instead
 *   of re-sending the original request.
 * - stopProxy closes whatever is still parked.
 * (Ported from the fork's 2357db8 + f203658.)
 *
 * Run: bun test/park-reap-regression.ts
 */
import type { StartClaudeQueryParams } from "../src/query.ts";
import { assert, callTool, mockHandle, startMockedProxy, textDelta } from "./helpers.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function promptText(prompt: StartClaudeQueryParams["prompt"]): Promise<string> {
  if (typeof prompt === "string") return prompt;
  let text = "";
  for await (const part of prompt) {
    text += JSON.stringify((part as { message?: { content?: unknown } }).message?.content);
    break;
  }
  return text;
}

async function main() {
  process.env.OPENCODE_CLAUDE_STRUCTURED_OUTPUT_REAP_MS = "200";
  const { post, proxy } = await startMockedProxy("reap");

  const toolDef = (name: string) => ({
    type: "function",
    function: { name, description: name, parameters: { type: "object", properties: {} } },
  });

  // Mock SDK turn that calls one bridged tool and then waits for its result,
  // like the real CLI does. Reports whether the proxy closed it.
  async function parkOn(toolName: string, session: string) {
    let closed = false;
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    proxy.setClaudeQueryStarter(async (params) =>
      mockHandle(
        (async function* () {
          yield { type: "system", subtype: "init", session_id: `${session}-sess` };
          callTool(params, toolName, {}).catch(() => {});
          await released;
        })(),
        () => {
          closed = true;
          release();
        },
      ),
    );
    const res = await post(session, {
      tools: [toolDef(toolName)],
      messages: [{ role: "user", content: "go" }],
    });
    assert.equal(res.status, 200);
    const json = (await res.json()) as any;
    const call = json.choices[0].message.tool_calls?.[0];
    assert.equal(call?.function.name, toolName);
    await sleep(600);
    return { closed: () => closed, release, call };
  }

  try {
    const structured = await parkOn("StructuredOutput", "reap-structured");
    assert.equal(structured.closed(), true, "StructuredOutput park is reaped");

    const regular = await parkOn("bash", "reap-regular");
    assert.equal(regular.closed(), false, "regular tool park is kept");
    regular.release();

    process.env.OPENCODE_CLAUDE_PARKED_TURN_TTL_MS = "200";
    const abandoned = await parkOn("bash", "reap-ttl");
    assert.equal(abandoned.closed(), true, "regular park is reaped past the TTL");

    // The late result rebuilds the turn: the step and its result are the
    // prompt, the original ask stays history (never the request again).
    let rebuilt = "";
    proxy.setClaudeQueryStarter(async (params) => {
      rebuilt = await promptText(params.prompt);
      return mockHandle(
        (async function* () {
          yield textDelta("RESUMED");
          yield { type: "result", is_error: false, usage: {} };
        })(),
      );
    });
    const late = await post("reap-ttl", {
      tools: [toolDef("bash")],
      messages: [
        { role: "user", content: "ORIGINAL-ASK" },
        { role: "assistant", content: null, tool_calls: [abandoned.call] },
        { role: "tool", tool_call_id: abandoned.call.id, content: "LATE-RESULT" },
      ],
    });
    assert.equal(late.status, 200);
    assert.match(String(((await late.json()) as any).choices[0].message.content), /RESUMED/);
    assert.match(rebuilt, /<tool_results>/);
    assert.match(rebuilt, /LATE-RESULT/);
    assert.match(rebuilt, /Continue the task/);
    assert.match(rebuilt, /not from the user/, "the interruption isn't blamed on the user");

    // stopProxy closes parks that are still waiting.
    delete process.env.OPENCODE_CLAUDE_PARKED_TURN_TTL_MS;
    const pending = await parkOn("bash", "reap-stop");
    assert.equal(pending.closed(), false);
    await proxy.stopProxy();
    assert.equal(pending.closed(), true, "stopProxy closes parked turns");
  } finally {
    proxy.setClaudeQueryStarter(null);
    await proxy.stopProxy();
  }
  console.log("ok — park reap regression passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
