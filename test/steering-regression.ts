/**
 * Regression: a user message sent while a bridged tool is running (OpenCode
 * puts it after the tool result in the resume request) must reach Claude
 * instead of being dropped. It goes into the turn's open input as a user
 * message (`priority: "next"`), not into the tool result, where Claude read
 * it as an injected instruction. OpenCode's promoted-media
 * marker message is not steering. (Ported from the fork's 4ca2338.)
 *
 * Run: bun test/steering-regression.ts
 */
import {
  assert,
  bashTool,
  callTool,
  mockHandle,
  startMockedProxy,
  textDelta,
} from "./helpers.ts";

async function main() {
  const { collectSteering, SYNTHETIC_TOOL_MEDIA_PROMPT } = await import(
    "../src/prompt.ts"
  );
  const texts = (messages: unknown[]) =>
    collectSteering(messages as any).map((b) => (b.type === "text" ? b.text : b.type));
  assert.deepEqual(texts([{ role: "user", content: "hi" }]), []);
  assert.deepEqual(texts([{ role: "user", content: "old" }, { role: "tool", content: "r" }]), []);
  assert.deepEqual(
    texts([
      { role: "user", content: "old" },
      { role: "tool", content: "r" },
      { role: "user", content: [{ type: "text", text: "use port 8080" }] },
      { role: "user", content: "and skip tests" },
    ]),
    ["use port 8080", "and skip tests"],
  );
  assert.deepEqual(
    texts([
      { role: "user", content: "old" },
      { role: "tool", content: "r" },
      { role: "user", content: SYNTHETIC_TOOL_MEDIA_PROMPT },
    ]),
    [],
  );

  const { post, proxy } = await startMockedProxy("steer");

  /** Messages the turn's input carries after its prompt, as the SDK reads them. */
  function drainInput(params: { prompt: unknown }, sink: any[]) {
    const prompt = params.prompt as AsyncIterable<any>;
    assert.ok(typeof prompt !== "string" && Symbol.asyncIterator in prompt, "a chat turn with tools keeps its input open");
    void (async () => {
      let first = true;
      for await (const m of prompt) {
        if (!first) sink.push(m);
        first = false;
      }
    })();
  }
  const inputText = (sink: any[]) =>
    sink.map((m) => (typeof m.message.content === "string" ? m.message.content : JSON.stringify(m.message.content))).join("\n");

  async function run(session: string, afterResult: unknown[], sink: any[] = []) {
    let received: string | null = null;
    proxy.setClaudeQueryStarter(async (params) => {
      drainInput(params, sink);
      return mockHandle(
        (async function* () {
          yield { type: "system", subtype: "init", session_id: `${session}-sess` };
          const res = await callTool(params, "bash", { command: "sleep 40" });
          received = res.content.map((b) => b.text ?? "").join("\n");
          // Like the real SDK, the tool result comes back as a user message
          // before the next assistant output.
          yield { type: "user", message: { role: "user", content: [] } };
          yield textDelta("DONE");
          yield { type: "result", is_error: false, usage: {} };
        })(),
      );
    });
    const first = (await (await post(session, {
      tools: [bashTool],
      messages: [{ role: "user", content: "run it" }],
    })).json()) as any;
    const call = first.choices[0].message.tool_calls[0];
    assert.equal(call.function.name, "bash");
    const resume = (await (await post(session, {
      tools: [bashTool],
      messages: [
        { role: "user", content: "run it" },
        { role: "assistant", content: null, tool_calls: [call] },
        { role: "tool", tool_call_id: call.id, content: "exit 0" },
        ...afterResult,
      ],
    })).json()) as any;
    assert.match(String(resume.choices[0].message.content), /DONE/);
    return received as string | null;
  }

  try {
    const sink: any[] = [];
    const steered = await run("steer-yes", [
      { role: "user", content: "Actually, the secret word is PINEAPPLE." },
    ], sink);
    assert.equal(steered, "exit 0", "the tool result stays the tool's own");
    assert.equal(sink.length, 1);
    assert.equal(sink[0].message.content, "Actually, the secret word is PINEAPPLE.");
    assert.equal(sink[0].priority, "next", "added after the running tool, within the turn");

    const plain = await run("steer-no", []);
    assert.equal(plain, "exit 0");

    // Results of one park arriving over two resume requests: the queued
    // message rides the first resolved result only, never both.
    const got: string[] = [];
    const splitSink: any[] = [];
    proxy.setClaudeQueryStarter(async (params) => {
      drainInput(params, splitSink);
      return mockHandle(
        (async function* () {
          yield { type: "system", subtype: "init", session_id: "steer-split-sess" };
          yield { type: "stream_event", event: { type: "message_start" } };
          const a = callTool(params, "bash", { command: "a" });
          const b = callTool(params, "bash", { command: "b" });
          yield { type: "stream_event", event: { type: "message_stop" } };
          for (const res of await Promise.all([a, b])) {
            got.push(res.content.map((c) => c.text ?? "").join("\n"));
          }
          yield textDelta("DONE");
          yield { type: "result", is_error: false, usage: {} };
        })(),
      );
    });
    const turn = [{ role: "user", content: "run both" }];
    const parked = (await (await post("steer-split", { tools: [bashTool], messages: turn })).json()) as any;
    const calls = parked.choices[0].message.tool_calls;
    assert.equal(calls.length, 2);
    const asst = { role: "assistant", content: null, tool_calls: calls };
    const steer = { role: "user", content: "Use MANGO instead." };
    const partial = (await (await post("steer-split", {
      tools: [bashTool],
      messages: [...turn, asst, { role: "tool", tool_call_id: calls[0].id, content: "ra" }, steer],
    })).json()) as any;
    assert.equal(partial.choices[0].finish_reason, "tool_calls");
    const done = (await (await post("steer-split", {
      tools: [bashTool],
      messages: [
        ...turn,
        asst,
        { role: "tool", tool_call_id: calls[0].id, content: "ra" },
        { role: "tool", tool_call_id: calls[1].id, content: "rb" },
        steer,
      ],
    })).json()) as any;
    assert.match(String(done.choices[0].message.content), /DONE/);
    assert.equal(inputText(splitSink).match(/MANGO/g)?.length, 1, "steering forwarded once");
    assert.ok(!got.join("\n").includes("MANGO"), "never inside a tool result");
  } finally {
    proxy.setClaudeQueryStarter(null);
    await proxy.stopProxy();
  }
  console.log("ok — steering regression passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
