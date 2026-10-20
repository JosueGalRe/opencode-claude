/**
 * Regression: a user message sent while a bridged tool is running (OpenCode
 * puts it after the tool result in the resume request) must reach Claude
 * instead of being dropped. It goes into the turn's open input as a user
 * message (`priority: "next"`), not into the tool result, where Claude read
 * it as an injected instruction; the input closes with the turn. OpenCode's
 * promoted-media marker message must NOT be treated as steering.
 *
 * Run: bun test/steering-regression.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROXY_TOKEN_HEADER } from "../src/constants.ts";

async function main() {
  const { collectSteeringText, withSteering } = await import("../src/steering.ts");
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const { SYNTHETIC_TOOL_MEDIA_PROMPT } = await import("../src/prompt.ts");
  assert.deepEqual(collectSteeringText([{ role: "user", content: "hi" }]), []);
  assert.deepEqual(
    collectSteeringText([
      { role: "user", content: "old" },
      { role: "tool", content: "r" },
    ]),
    [],
  );
  assert.deepEqual(
    collectSteeringText([
      { role: "user", content: "old" },
      { role: "tool", content: "r" },
      { role: "user", content: [{ type: "text", text: "use port 8080" }] },
      { role: "user", content: "and skip tests" },
    ]),
    ["use port 8080", "and skip tests"],
  );
  assert.deepEqual(
    collectSteeringText([
      { role: "user", content: "old" },
      { role: "tool", content: "r" },
      { role: "user", content: SYNTHETIC_TOOL_MEDIA_PROMPT },
    ]),
    [],
  );

  const tmp = mkdtempSync(join(tmpdir(), "opencode-claude-steer-"));
  process.env.XDG_DATA_HOME = tmp;
  process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE = join(tmp, "rate-limit.json");

  const { startProxy, stopProxy, setClaudeQueryStarter, getProxyAuthToken } = await import(
    "../src/proxy.ts"
  );
  const port = await startProxy();

  const bashTool = {
    type: "function",
    function: {
      name: "bash",
      description: "Run a command",
      parameters: { type: "object", properties: { command: { type: "string" } } },
    },
  };
  const post = (session: string, messages: unknown[]) =>
    fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [PROXY_TOKEN_HEADER]: getProxyAuthToken(),
        "x-opencode-claude-session": session,
      },
      body: JSON.stringify({ model: "sonnet", stream: false, tools: [bashTool], messages }),
    });

  // Mock SDK turn: read the turn's input like the SDK, call bash, record the
  // tool result text Claude receives, then finish the turn.
  async function run(session: string, afterResult: unknown[]) {
    let received: string | null = null;
    const input: any[] = [];
    let inputClosed: Promise<void> = Promise.resolve();
    setClaudeQueryStarter(async (params) => {
      const prompt = params.prompt as AsyncIterable<any>;
      assert.ok(typeof prompt !== "string" && Symbol.asyncIterator in prompt, "a chat turn with tools keeps its input open");
      inputClosed = (async () => {
        let first = true;
        for await (const message of prompt) {
          if (!first) input.push(message);
          first = false;
        }
      })();
      const server = (params.mcpServers as Record<string, any>).opencode;
      const handlers =
        server.instance.server?._requestHandlers ??
        server.instance._requestHandlers;
      return {
        stream: (async function* () {
          yield { type: "system", subtype: "init", session_id: `${session}-sess` };
          const res = await handlers.get("tools/call")(
            { method: "tools/call", params: { name: "bash", arguments: { command: "sleep 40" } } },
            {},
          );
          received = res.content
            .map((b: { text?: string }) => b.text ?? "")
            .join("\n");
          // Like the real SDK, the tool result comes back as a user message
          // before the next assistant output (a pending next() consumes it).
          yield { type: "user", message: { role: "user", content: [] } };
          yield {
            type: "stream_event",
            event: { type: "content_block_delta", delta: { type: "text_delta", text: "DONE" } },
          };
          yield { type: "result", is_error: false, usage: {} };
        })(),
        close: () => {},
      };
    });

    const first = await post(session, [{ role: "user", content: "run it" }]);
    const firstJson = (await first.json()) as any;
    const call = firstJson.choices[0].message.tool_calls[0];
    assert.equal(call.function.name, "bash");

    const resume = await post(session, [
      { role: "user", content: "run it" },
      { role: "assistant", content: null, tool_calls: [call] },
      { role: "tool", tool_call_id: call.id, content: "exit 0" },
      ...afterResult,
    ]);
    const resumeJson = (await resume.json()) as any;
    assert.match(String(resumeJson.choices[0].message.content), /DONE/);
    // The result closed the input, so the CLI can exit.
    const closed = await Promise.race([inputClosed.then(() => true), sleep(1000).then(() => false)]);
    assert.ok(closed, "the turn's input ends with its result");
    return { received, input };
  }

  try {
    const steered = await run("steer-yes", [
      { role: "user", content: "Actually, the secret word is PINEAPPLE." },
    ]);
    assert.equal(steered.received, "exit 0", "the tool result stays the tool's own");
    assert.equal(steered.input.length, 1);
    assert.equal(steered.input[0].message.content, "Actually, the secret word is PINEAPPLE.");
    assert.equal(steered.input[0].priority, "next", "added after the running tool, within the turn");

    const plain = await run("steer-no", []);
    assert.equal(plain.received, "exit 0");
    assert.deepEqual(plain.input, []);

    // A session context entry that changed while the tool ran arrives as
    // `<system-update>` user text; it goes in as it is, like a user message.
    const update =
      '<system-update>\nThe context under "openchamber.pinned" changed and supersedes the previous value:\n<context key="openchamber.pinned">\nShip on Friday.\n</context>\n</system-update>';
    const both = await run("steer-update-user", [
      { role: "user", content: update },
      { role: "user", content: "stop after this" },
    ]);
    assert.equal(both.received, "exit 0");
    assert.deepEqual(both.input.map((m) => m.message.content), [update, "stop after this"]);

    // Without an open input (a closed one, or a turn from before this
    // change) steering rides the tool result; a `<system-update>` there is
    // the host's, not passed off as the user's message.
    const result = [{ type: "text" as const, text: "exit 0" }];
    assert.deepEqual(withSteering(result, [update]).map((b: any) => b.text), ["exit 0", update]);
    const fallback = withSteering(result, [update, "stop after this"]).map((b: any) => b.text);
    assert.equal(fallback.length, 3);
    assert.equal(fallback[1], update);
    assert.match(fallback[2]!, /<system-reminder>[\s\S]*the user sent[\s\S]*stop after this[\s\S]*<\/system-reminder>/);
    assert.doesNotMatch(fallback[2]!, /Ship on Friday/);
  } finally {
    await stopProxy();
  }
  console.log("ok — steering regression passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
