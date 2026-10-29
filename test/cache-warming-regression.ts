/**
 * Regression: OpenCode's cache warming pings an idle chat with a generate
 * request every few minutes. Through Claude Code the ping warms nothing the
 * chat's turns reuse, and each one re-read the whole history from the plan's
 * limits. It is answered without starting Claude; other generate requests
 * still run.
 *
 * Run: bun test/cache-warming-regression.ts
 */
import { assert, mockHandle, startMockedProxy, textDelta } from "./helpers.ts";

const WARMING_PROMPT =
  "This is a keep-alive request. Do not perform any work or use tools. Reply with exactly: OK";

async function main() {
  const { port, proxy } = await startMockedProxy("cache-warming");
  let starts = 0;
  proxy.setClaudeQueryStarter(async () => {
    starts += 1;
    return mockHandle(
      (async function* () {
        yield textDelta("generated");
        yield { type: "result", is_error: false, usage: {} };
      })(),
    );
  });
  const generate = (prompt: string, stream: boolean) =>
    fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-opencode-claude-session": "ses_warm",
        "x-opencode-claude-kind": "generate",
      },
      body: JSON.stringify({
        model: "sonnet",
        stream,
        messages: [
          { role: "user", content: "long chat history" },
          { role: "assistant", content: "answer" },
          { role: "user", content: prompt },
        ],
      }),
    });

  try {
    const plain = await generate(WARMING_PROMPT, false);
    assert.equal(plain.status, 200);
    const json = (await plain.json()) as any;
    assert.equal(json.choices[0].message.content, "OK");
    assert.equal(json.usage.total_tokens, 0);

    const streamed = await generate(WARMING_PROMPT, true);
    assert.equal(streamed.status, 200);
    const sse = await streamed.text();
    assert.match(sse, /"content":"OK"/);
    assert.match(sse, /"finish_reason":"stop"/);
    assert.match(sse, /data: \[DONE\]/);
    assert.equal(starts, 0, "a warming ping never starts Claude");

    const real = await generate("Summarize the open questions.", false);
    assert.equal(((await real.json()) as any).choices[0].message.content, "generated");
    assert.equal(starts, 1, "other generate requests still run");
  } finally {
    proxy.setClaudeQueryStarter(null);
    await proxy.stopProxy();
  }
  console.log("ok — cache warming regression passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
