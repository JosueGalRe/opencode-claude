/**
 * Chat turns ask Claude Code to keep the working directory, memory path and
 * git status out of its system prompt: with them in, no two sessions share
 * the prompt and every new session writes all of it to the cache again.
 * Utility turns keep their own one-line prompt, and
 * OPENCODE_CLAUDE_DYNAMIC_SECTIONS=keep restores the old layout.
 * Ported from upstream 1.3.8.
 */
import type { StartClaudeQueryParams } from "../src/query.ts";
import { assert, mockHandle, startMockedProxy, textDelta, user } from "./helpers.ts";

async function main() {
  // The flag reaches the SDK only for the claude_code preset.
  const { startClaudeQuery } = await import("../src/query.ts");
  const sdkPrompt = async (systemPrompt: StartClaudeQueryParams["systemPrompt"]) => {
    let seen: Record<string, unknown> | undefined;
    await startClaudeQuery({
      prompt: "x",
      cwd: process.cwd(),
      systemPrompt,
      queryImpl: () => (input: { options: Record<string, unknown> }) => {
        seen = input.options;
        return (async function* () {})();
      },
    });
    return seen!.systemPrompt;
  };
  assert.deepEqual(
    await sdkPrompt({ type: "preset", preset: "claude_code", excludeDynamicSections: true }),
    { type: "preset", preset: "claude_code", excludeDynamicSections: true },
  );
  assert.deepEqual(await sdkPrompt({ type: "preset", preset: "claude_code" }), { type: "preset", preset: "claude_code" });

  const h = await startMockedProxy("dynamic-sections");
  const prompts: unknown[] = [];
  h.proxy.setClaudeQueryStarter(async (params) => {
    prompts.push(params.systemPrompt);
    return mockHandle((async function* () {
      yield { type: "system", subtype: "init", session_id: "sess-dynamic" };
      yield textDelta("ok");
      yield { type: "result", is_error: false, usage: {}, session_id: "sess-dynamic" };
    })());
  });
  const turn = async (session: string, messages: unknown[]) => {
    const res = await h.post(session, { messages });
    assert.equal(res.status, 200, await res.clone().text());
    await res.text();
    return prompts.at(-1) as { excludeDynamicSections?: boolean } | string;
  };

  try {
    const chat = await turn("dyn-chat", [user("hello")]);
    assert.ok(typeof chat !== "string");
    assert.equal(chat.excludeDynamicSections, true, "chat turns drop the dynamic sections");

    const title = await turn("dyn-title", [
      { role: "system", content: "You are a title generator. Output only a thread title." },
      user("hello"),
    ]);
    assert.equal(typeof title, "string", "a title keeps its own one-line prompt");

    process.env.OPENCODE_CLAUDE_DYNAMIC_SECTIONS = "keep";
    const kept = await turn("dyn-keep", [user("hello")]);
    assert.ok(typeof kept !== "string");
    assert.equal(kept.excludeDynamicSections, undefined, "keep restores the old layout");
  } finally {
    delete process.env.OPENCODE_CLAUDE_DYNAMIC_SECTIONS;
    await h.cleanup();
  }
  console.log("ok — dynamic sections regression passed");
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
