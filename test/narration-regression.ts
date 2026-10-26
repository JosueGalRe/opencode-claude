/**
 * Regression: Opus 5.5 sends its update before a tool call as a thinking
 * block whose signature is tagged "narration". It must reach OpenCode as
 * answer text, not reasoning.
 * - A thinking block is held until its signature: narration becomes text,
 *   anything else stays reasoning.
 * - Block 0 is narration when Claude goes straight to a tool (#68); once it
 *   streams a second delta it is real thinking and goes out live.
 *
 * Run: bun test/narration-regression.ts
 */
import { assert, mockHandle, startMockedProxy } from "./helpers.ts";

const block = (index: number, event: Record<string, unknown>) => ({ type: "stream_event", event: { index, ...event } });
const thinkingBlock = (index: number, thinking: string | string[], tag: string) => [
  block(index, { type: "content_block_start", content_block: { type: "thinking", thinking: "", signature: "" } }),
  ...[thinking].flat().map((chunk) => block(index, { type: "content_block_delta", delta: { type: "thinking_delta", thinking: chunk } })),
  block(index, { type: "content_block_delta", delta: { type: "signature_delta", signature: Buffer.from(`\x08\x04B\t${tag}`).toString("base64") } }),
  block(index, { type: "content_block_stop" }),
];

function parseSse(sse: string): { content: string; reasoning: string } {
  let content = "";
  let reasoning = "";
  for (const line of sse.split("\n")) {
    if (!line.startsWith("data: {")) continue;
    const delta = JSON.parse(line.slice(6)).choices?.[0]?.delta;
    content += delta?.content ?? "";
    reasoning += delta?.reasoning_content ?? "";
  }
  return { content, reasoning };
}

async function main() {
  const { post, proxy } = await startMockedProxy("narration");
  try {
    const cases = [
      {
        name: "after-thinking",
        blocks: [
          thinkingBlock(0, ["pl", "an"], "thinking"),
          thinkingBlock(1, "Checking the logs next.", "narration"),
          thinkingBlock(2, " later", "thinking"),
        ],
        expected: { content: "Checking the logs next.", reasoning: "plan later" },
      },
      {
        name: "first-block",
        blocks: [thinkingBlock(0, "Asking which branch to use.", "narration")],
        expected: { content: "Asking which branch to use.", reasoning: "" },
      },
      {
        name: "short-thinking",
        blocks: [thinkingBlock(0, "plan", "thinking")],
        expected: { content: "", reasoning: "plan" },
      },
    ];
    for (const { name, blocks, expected } of cases) for (const stream of [true, false]) {
      proxy.setClaudeQueryStarter(async () =>
        mockHandle(
          (async function* () {
            for (const events of blocks) yield* events;
            yield { type: "result", is_error: false, usage: {} };
          })(),
        ),
      );
      const res = await post(`narration-${name}-${stream}`, { stream, messages: [{ role: "user", content: "hi" }] });
      assert.equal(res.status, 200);
      let out: { content: string; reasoning: string };
      if (stream) out = parseSse(await res.text());
      else {
        const message = ((await res.json()) as any).choices[0].message;
        out = { content: message.content ?? "", reasoning: message.reasoning_content ?? "" };
      }
      assert.deepEqual(out, expected, `${name} stream=${stream}`);
    }
  } finally {
    proxy.setClaudeQueryStarter(null);
    await proxy.stopProxy();
  }
  console.log("ok — narration regression passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
