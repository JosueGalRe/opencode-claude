/** End-to-end regressions for upstream v1.3.0 turn errors, notices and retries. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyClaudeFailure, resultErrorText, thrownErrorText } from "../src/failure.ts";

const diag = "[ede_diagnostic] result_type=user stop_reason=tool_use";
const text = (value: string) => ({
  type: "stream_event",
  event: { type: "content_block_delta", delta: { type: "text_delta", text: value } },
});
const stop = (reason: string, parent_tool_use_id: string | null = null) => ({
  type: "stream_event",
  parent_tool_use_id,
  event: { type: "message_delta", delta: { stop_reason: reason }, usage: { output_tokens: 1 } },
});
const result = (more: Record<string, unknown> = {}) => ({ type: "result", is_error: false, usage: {}, ...more });

type Choice = { finish_reason?: string | null; delta?: { reasoning_content?: string }; message?: { reasoning_content?: string } };
type Body = { error: { message: string; type: string; code: string }; choices: Choice[] };
function sse(s: string): { finish: string | null; reasoning: string } {
  let finish: string | null = null;
  let reasoning = "";
  for (const line of s.split("\n")) {
    if (!line.startsWith("data: {")) continue;
    const choice = (JSON.parse(line.slice(6)) as { choices?: Choice[] }).choices?.[0];
    if (choice?.finish_reason) finish = choice.finish_reason;
    reasoning += choice?.delta?.reasoning_content ?? "";
  }
  return { finish, reasoning };
}

async function main() {
  // Given: an isolated proxy and a replaceable SDK iterator.
  const dir = mkdtempSync(join(tmpdir(), "opencode-claude-turn-fixes-"));
  process.env.XDG_DATA_HOME = dir;
  process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE = join(dir, "rate-limit.json");
  process.env.OPENCODE_CLAUDE_TURN_STALL_MS = "1000";
  const proxy = await import("../src/proxy.ts");
  const port = await proxy.startProxy();
  let spawns = 0;
  const turn = (events: () => AsyncGenerator<unknown>) => proxy.setClaudeQueryStarter(async () => {
    spawns++;
    return { stream: events(), close: () => {} };
  });
  const post = async (session: string, stream: boolean, kind?: string) => fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${proxy.getProxyAuthToken()}`,
      "x-opencode-claude-session": session,
      ...(kind ? { "x-opencode-claude-request-kind": kind } : {}),
    },
    body: JSON.stringify({ model: "sonnet", stream, messages: [{ role: "user", content: "hi" }] }),
  });
  const events = (...items: unknown[]) => async function* () { yield* items; };
  try {
    // When: an error result supplies errors[]/terminal_reason instead of result.
    assert.equal(resultErrorText({ is_error: true, errors: [diag], terminal_reason: "prompt_too_long" }),
      "Prompt is too long: the conversation exceeds the context window.");
    assert.equal(resultErrorText({ is_error: true, errors: [diag, "API Error: 500 boom"] }), "API Error: 500 boom");
    assert.equal(thrownErrorText(new Error(`Claude Code returned an error result: ${diag}`)), null);
    for (const stream of [true, false]) {
      turn(events(result({ is_error: true, errors: [diag], terminal_reason: "prompt_too_long" })));
      const res = await post(`overflow-${stream}`, stream);
      assert.equal(res.status, 400);
      const body = await res.json() as Body;
      assert.equal(body.error.code, "context_length_exceeded");
      assert.doesNotMatch(body.error.message, /ede_diagnostic/);
    }
    turn(events(text("partial"), result({ is_error: true, result: "Prompt is too long" })));
    assert.equal((await post("late-overflow", false)).status, 400);
    turn(events(result({ is_error: true, errors: ["Could not process image"] })));
    const image = await post("image", true);
    assert.equal(image.status, 400);
    assert.equal(((await image.json()) as Body).error.code, "claude_image_error");
    turn(events(result({ is_error: true, subtype: "error_max_turns", terminal_reason: "max_turns" })));
    const title = await post("title", false, "title");
    assert.match(((await title.json()) as Body).error.message, /session title in the single step/);
    const sessions = await import("../src/session-store.ts");
    sessions.setForeignSessionId("lost", "gone");
    turn(events(result({ is_error: true, errors: ["No conversation found with session ID: gone"] })));
    assert.equal((await post("lost", true)).status, 500);
    assert.equal(sessions.getForeignSessionId("lost"), undefined);
    turn(async function* () {
      yield text("partial answer");
      yield result({ is_error: true, errors: [diag, "API Error: 500 boom"] });
      throw new Error(`Claude Code returned an error result: ${diag}; API Error: 500 boom`);
    });
    const midStream = await (await post("midstream", true)).text();
    assert.doesNotMatch(midStream, /ede_diagnostic/);
    assert.equal(midStream.match(/API Error: 500 boom/g)?.length, 1);

    // When: the main conversation is truncated/refused, OpenAI sees the real finish reason.
    for (const stream of [true, false]) {
      turn(events(text("answer"), stop("max_tokens"), result({ stop_reason: "max_tokens" })));
      const length = await post(`length-${stream}`, stream);
      const finish = stream ? sse(await length.text()).finish : ((await length.json()) as Body).choices[0]?.finish_reason;
      assert.equal(finish, "length");
      turn(events(text("answer"), stop("max_tokens", "subagent"), stop("end_turn"), result({ stop_reason: "end_turn" })));
      const normal = await post(`normal-${stream}`, stream);
      assert.equal(stream ? sse(await normal.text()).finish : ((await normal.json()) as Body).choices[0]?.finish_reason, "stop");
      turn(events(text("I can't"), stop("refusal"), result({ stop_reason: "refusal" })));
      const refused = await post(`filter-${stream}`, stream);
      if (stream) {
        const filtered = sse(await refused.text());
        assert.equal(filtered.finish, "content_filter");
        assert.match(filtered.reasoning, /Claude declined/);
      } else {
        const body = await refused.json() as Body;
        assert.equal(body.choices[0]?.finish_reason, "content_filter");
        assert.match(body.choices[0]?.message?.reasoning_content ?? "", /Claude declined/);
      }
    }

    // When: the CLI supplies its refusal explanation, warnings and deduped notices.
    const refusal = { type: "system", subtype: "model_refusal_no_fallback", api_refusal_category: "cyber", api_refusal_explanation: "Policy reason" };
    turn(events(refusal, result({ stop_reason: "refusal" })));
    const explained = sse(await (await post("explained", true)).text());
    assert.equal(explained.finish, "content_filter");
    assert.match(explained.reasoning, /Claude declined this request \(cyber\): Policy reason/);
    assert.doesNotMatch(explained.reasoning, /declined to answer/);
    for (const stream of [true, false]) {
      turn(events(refusal, result({ is_error: true, result: "No answer" })));
      const res = await post(`refusal-error-${stream}`, stream);
      assert.equal(res.status, 400);
      const body = await res.json() as Body;
      assert.equal(body.error.code, "refusal");
      assert.match(body.error.message, /Policy reason/);
    }
    const warning = { type: "system", subtype: "notification", priority: "high", key: "ctx", text: "Context nearly full" };
    turn(events(warning, warning, { ...warning, priority: "low", text: "UI tip" },
      { type: "system", subtype: "informational", level: "warning", content: "Stop hook warning" }, text("answer"), result()));
    const notices = sse(await (await post("notices", true)).text()).reasoning;
    assert.equal(notices.match(/Context nearly full/g)?.length, 1);
    assert.match(notices, /Stop hook warning/);
    assert.doesNotMatch(notices, /UI tip/);

    // When: CLI exhausts 5xx retries but labels an empty result success.
    for (const stream of [true, false]) {
      turn(events(result({ api_error_status: 529, result: "" })));
      spawns = 0;
      const res = await post(`overloaded-${stream}`, stream);
      assert.equal(res.status, 503);
      const body = await res.json() as Body;
      assert.equal(body.error.code, "overloaded_error");
      assert.match(body.error.message, /529/);
      assert.equal(spawns, 1);
    }
    turn(events(result({ api_error_status: 502 })));
    assert.equal((await post("upstream-502", true)).status, 503);
    turn(events(text("answer"), result({ api_error_status: 529 })));
    assert.equal((await post("answered-529", false)).status, 200);

    // When: CLI retries, show its schedule, hold the HTTP head, extend stall time.
    const retry = (delay: number) => ({ type: "system", subtype: "api_retry", attempt: 2, max_retries: 10, error_status: 529, retry_delay_ms: delay });
    turn(events(retry(4000), text("answer"), result()));
    const retried = sse(await (await post("retried", true)).text());
    assert.match(retried.reasoning, /Anthropic returned 529, retrying in 4s \(attempt 2\/10\)/);
    turn(events(retry(10), result({ is_error: true, errors: ["API Error: 529 Overloaded"] })));
    assert.notEqual((await post("retry-exhausted", true)).status, 200);
    turn(async function* () {
      yield retry(1500);
      await new Promise((resolve) => setTimeout(resolve, 1800));
      yield text("after the wait");
      yield result();
    });
    assert.match(await (await post("slow-retry", true)).text(), /after the wait/);

    // When: Anthropic moves third-party usage off-plan, do not retry as a 500.
    const billing = "API Error: 400 Third-party apps now draw from extra usage, not plan limits";
    assert.equal(classifyClaudeFailure(billing), "billing");
    assert.equal(classifyClaudeFailure("credit balance is too low"), "billing");
    for (const stream of [true, false]) {
      turn(events(result({ is_error: true, errors: [billing] })));
      const res = await post(`billing-${stream}`, stream);
      assert.equal(res.status, 402);
      const body = await res.json() as Body;
      assert.equal(body.error.type, "billing_error");
      assert.equal(body.error.code, "claude_extra_usage");
      assert.match(body.error.message, /Third-party apps now draw from extra usage/);
    }
  } finally {
    proxy.setClaudeQueryStarter(null);
    await proxy.stopProxy();
    rmSync(dir, { recursive: true, force: true });
  }
  console.log("ok — v1.3 turn fixes regression passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
