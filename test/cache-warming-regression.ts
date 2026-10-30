/**
 * Regression: OpenCode's cache warming (`"warming": true`) pings an idle chat
 * with a generate request every 4 minutes for 30 minutes. Through Claude Code
 * the ping warms nothing the chat's turns reuse, and each one transferred the
 * whole history to a fresh Claude turn. It is answered without starting
 * Claude; other generate requests still run. (Ported from upstream 1.6.1,
 * dab1917.)
 *
 * Run: bun test/cache-warming-regression.ts
 */
import { REQUEST_KIND_HEADER } from "../src/constants.ts";
import { assert, mockHandle, result, startMockedProxy, textDelta } from "./helpers.ts";

const WARMING_PROMPT =
  "This is a keep-alive request. Do not perform any work or use tools. Reply with exactly: OK";

async function main() {
  const h = await startMockedProxy("cache-warming");
  let starts = 0;
  h.proxy.setClaudeQueryStarter(async () => {
    starts += 1;
    return mockHandle((async function* () {
      yield textDelta("generated");
      yield result;
    })());
  });
  const generate = (prompt: string, stream: boolean) =>
    h.post("ses_warm", {
      stream,
      messages: [
        { role: "user", content: "long chat history" },
        { role: "assistant", content: "answer" },
        { role: "user", content: prompt },
      ],
    }, { [REQUEST_KIND_HEADER]: "generate" });

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

    // The same text as a chat message is the user's, not a ping.
    const chat = await h.post("ses_warm_chat", { messages: [{ role: "user", content: WARMING_PROMPT }] });
    assert.equal(((await chat.json()) as any).choices[0].message.content, "generated");
    assert.equal(starts, 2);
  } finally {
    await h.cleanup();
  }
  console.log("ok — cache warming regression passed");
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
