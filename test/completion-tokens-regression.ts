/**
 * Regression: the CLI's `assistant` events carry the message_start usage
 * snapshot (output_tokens ≈ 3); the real output_tokens only arrive on the
 * call's `message_delta` stream_event. completion_tokens must use the final
 * count, per API call, without double counting the terminal `result`.
 *
 * Run: bun test/completion-tokens-regression.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Usage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens?: number };
  aggregate_usage?: Usage;
};

const tmp = mkdtempSync(join(tmpdir(), "opencode-claude-completion-"));
process.env.XDG_DATA_HOME = tmp;
process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE = join(tmp, "rate-limit.json");

// Dynamic: the env above must be set before the proxy modules load.
const { getProxyAuthToken, setClaudeQueryStarter, startProxy, stopProxy } =
  await import("../src/proxy.ts");

const SESSION_ID = "sess-completion-tokens";
const stream = (event: Record<string, unknown>) => ({
  type: "stream_event",
  session_id: SESSION_ID,
  parent_tool_use_id: null,
  event,
});

/** One API call as the CLI streams it: start, assistant snapshot, delta, stop. */
function apiCall(options: {
  id: string;
  input: number;
  cacheRead: number;
  finalOutput: number;
  block: Record<string, unknown>;
  deltaInput?: number | null;
}): Record<string, unknown>[] {
  const startUsage = {
    input_tokens: options.input,
    cache_read_input_tokens: options.cacheRead,
    cache_creation_input_tokens: 0,
    output_tokens: 3,
  };
  return [
    stream({
      type: "message_start",
      message: { id: options.id, usage: startUsage },
    }),
    ...(options.block.type === "text"
      ? [
          stream({
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: options.block.text },
          }),
        ]
      : []),
    {
      type: "assistant",
      session_id: SESSION_ID,
      parent_tool_use_id: null,
      message: { id: options.id, content: [options.block], usage: startUsage },
    },
    stream({ type: "content_block_stop", index: 0 }),
    stream({
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: {
        input_tokens:
          options.deltaInput === undefined ? options.input : options.deltaInput,
        cache_read_input_tokens: options.cacheRead,
        cache_creation_input_tokens: 0,
        output_tokens: options.finalOutput,
      },
    }),
    stream({ type: "message_stop" }),
  ];
}

const singleCall = [
  ...apiCall({
    id: "msg-single",
    input: 10,
    cacheRead: 1_000,
    finalOutput: 250,
    block: { type: "text", text: "hello" },
  }),
  {
    type: "result",
    is_error: false,
    session_id: SESSION_ID,
    usage: {
      input_tokens: 10,
      cache_read_input_tokens: 1_000,
      output_tokens: 250,
    },
  },
];

// Tool-use turn: the CLI runs the tool itself, then makes a second API call.
const multiCall = [
  ...apiCall({
    id: "msg-tool",
    input: 10,
    cacheRead: 1_000,
    finalOutput: 250,
    // message_delta may leave input counts null: the start values must stand.
    deltaInput: null,
    block: { type: "tool_use", id: "toolu_1", name: "Read", input: {} },
  }),
  {
    type: "user",
    session_id: SESSION_ID,
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "x" }],
    },
  },
  ...apiCall({
    id: "msg-answer",
    input: 20,
    cacheRead: 1_300,
    finalOutput: 40,
    block: { type: "text", text: "done" },
  }),
  {
    type: "result",
    is_error: false,
    session_id: SESSION_ID,
    usage: {
      input_tokens: 30,
      cache_read_input_tokens: 2_300,
      output_tokens: 290,
    },
  },
];

let script: Record<string, unknown>[] = singleCall;
setClaudeQueryStarter(async () => ({
  stream: (async function* () {
    for (const event of script) yield event;
  })(),
  close: () => {},
}));
const port = await startProxy();

let requestCount = 0;
async function usageFor(events: Record<string, unknown>[], streaming: boolean) {
  script = events;
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${getProxyAuthToken()}`,
      "x-opencode-claude-session": `completion-tokens-${requestCount++}`,
    },
    body: JSON.stringify({
      model: "sonnet",
      stream: streaming,
      messages: [{ role: "user", content: "count my tokens" }],
    }),
  });
  assert.equal(response.status, 200);
  if (!streaming) return ((await response.json()) as { usage?: Usage }).usage;
  const chunks = (await response.text())
    .split("\n\n")
    .map((block) => block.split("\n").find((l) => l.startsWith("data: ")))
    .filter((line): line is string => !!line && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice("data: ".length)) as { usage?: Usage });
  return chunks.find((chunk) => chunk.usage)?.usage;
}

try {
  for (const streaming of [false, true]) {
    const label = streaming ? "streaming" : "buffered";

    const single = await usageFor(singleCall, streaming);
    assert.equal(single?.completion_tokens, 250, `${label}: single completion`);
    assert.equal(single?.prompt_tokens, 1_010, `${label}: single prompt`);
    assert.equal(single?.total_tokens, 1_260, `${label}: single total`);
    assert.equal(single?.aggregate_usage, undefined, `${label}: single aggregate`);

    const multi = await usageFor(multiCall, streaming);
    // Context size = the latest API call, with its final output count.
    assert.equal(multi?.completion_tokens, 40, `${label}: multi completion`);
    assert.equal(multi?.prompt_tokens, 1_320, `${label}: multi prompt`);
    assert.equal(multi?.total_tokens, 1_360, `${label}: multi total`);
    // The turn's sum uses every call's final count, counted once each.
    assert.equal(
      multi?.aggregate_usage?.completion_tokens,
      290,
      `${label}: multi aggregate completion`,
    );
    assert.equal(
      multi?.aggregate_usage?.prompt_tokens,
      2_330,
      `${label}: multi aggregate prompt`,
    );
    assert.equal(
      multi?.aggregate_usage?.total_tokens,
      2_620,
      `${label}: multi aggregate total`,
    );
  }
} finally {
  setClaudeQueryStarter(null);
  await stopProxy();
}

console.log("ok — completion tokens regression passed");
