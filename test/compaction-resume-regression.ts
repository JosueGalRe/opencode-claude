/**
 * OpenCode's compaction summary read a text copy of the chat cut to 400k
 * characters, with every tool result cut to 1000: on a long chat it saw a
 * fraction of the conversation, uncached. The summary now resumes an
 * in-memory fork of the chat's Claude session, cut where the summarized part
 * ends, with the chat turn's model, system prompt and tools (same prompt
 * cache); nothing is written to the session. Ported from upstream 1.3.5.
 * - A nudge after a reply that missed the template resumes at the same
 *   point with the summary prompt.
 * - A chat with no resumable session, or a branched transcript, gets the
 *   history as text, sized to the chat model.
 */
import { appendFileSync } from "node:fs";
import type { StartClaudeQueryParams } from "../src/query.ts";
import { REQUEST_KIND_HEADER } from "../src/constants.ts";
import { assert, assistant, bashTool, mockHandle, promptText, startMockedProxy, textDelta, user } from "./helpers.ts";

const SUMMARY_PROMPT = "Summarize the conversation above using the template.";
const NUDGE = "The previous response did not fill in the required summary template. Do not call tools.";

async function main() {
  const h = await startMockedProxy("compaction-resume");
  const { getForeignSessionId } = await import("../src/session-store.ts");
  let seen: StartClaudeQueryParams | null = null;
  let chatParams: StartClaudeQueryParams | null = null;
  let fresh = 0;
  let leaves = 0;
  h.proxy.setClaudeQueryStarter(async (params) => {
    seen = params;
    const summary = params.persistSession === false;
    if (!summary) chatParams = params;
    const session = params.resume ?? (summary ? "none" : `chat-sess-${++fresh}`);
    const leaf = `L${++leaves}`;
    if (!summary) h.append(session, leaf);
    return mockHandle((async function* () {
      yield { type: "system", subtype: "init", session_id: summary ? "in-memory-fork" : session };
      if (!summary) yield { type: "assistant", uuid: leaf, session_id: session, parent_tool_use_id: null };
      yield textDelta(summary ? "## Objective\n- the summary" : `answer ${leaf}`);
      yield { type: "result", is_error: false, usage: {}, session_id: session };
    })());
  });

  const turn = async (messages: unknown[]) => {
    const res = await h.post("chat", { tools: [bashTool], messages });
    assert.equal(res.status, 200);
    await res.text();
  };
  const summarize = async (key: string, messages: unknown[]) => {
    seen = null;
    const res = await h.post(key, { tools: [bashTool], stream: false, messages }, { [REQUEST_KIND_HEADER]: "compaction" });
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.match(body.choices[0].message.content, /the summary/);
    return seen!;
  };
  const chat = async () => {
    await turn(h1);
    await turn(h2);
    await turn(h3);
    return getForeignSessionId("chat")!;
  };
  const h1 = [user("one")];
  const h2 = [...h1, assistant("answer one"), user("two")];
  const h3 = [...h2, assistant("answer two"), user("three")];
  // OpenCode keeps "three" verbatim and summarizes the turns before it.
  const older = [...h2, assistant("answer two")];

  try {
    let session = await chat();
    let cut = `L${leaves - 1}`;
    {
      const params = await summarize("chat", [...older, user(SUMMARY_PROMPT)]);
      assert.equal(params.resume, session, "resumes the chat's Claude session");
      assert.equal(params.resumeSessionAt, cut, "cut where the summarized part ends");
      assert.equal(params.forkSession, true);
      assert.equal(params.persistSession, false, "nothing written to the session");
      assert.equal(params.model, chatParams!.model);
      assert.deepEqual(params.systemPrompt, chatParams!.systemPrompt, "same system prompt as the chat turn");
      assert.ok(params.mcpServers, "same tools as the chat turn");
      assert.deepEqual(params.toolAliases, chatParams!.toolAliases);
      assert.equal(params.thinking, undefined, "same thinking as the chat turn");
      assert.equal(params.settingSources, undefined);
      assert.equal(params.permissionMode, "dontAsk", "tool calls are refused");
      assert.equal(params.allowedTools, undefined);
      assert.equal(params.maxTurns, 2);
      assert.equal(params.autoCompactEnabled, false);
      assert.equal(params.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY, undefined, "keeps the chat's memory");
      const text = await promptText(params.prompt);
      assert.ok(text.includes(SUMMARY_PROMPT));
      assert.ok(!text.includes("<conversation_history>"), "no text copy of the chat");
      assert.equal(getForeignSessionId("chat"), undefined, "the chat starts a new session after compaction");
    }

    // Same chat again, with a nudge after a reply that missed the template.
    session = await chat();
    cut = `L${leaves - 1}`;
    {
      const params = await summarize("chat", [...older, user(SUMMARY_PROMPT), assistant("not a summary"), user(NUDGE)]);
      assert.equal(params.resume, session);
      assert.equal(params.resumeSessionAt, cut);
      const text = await promptText(params.prompt);
      assert.ok(text.includes(SUMMARY_PROMPT), "the summary prompt, not only the nudge");
      assert.ok(!text.includes(NUDGE));
    }

    // A side branch after the cut: resumeSessionAt could miss it, so text.
    session = await chat();
    appendFileSync(h.append(session), JSON.stringify({ type: "user", uuid: "side", parentUuid: "elsewhere" }) + "\n");
    {
      const params = await summarize("chat", [...older, user(SUMMARY_PROMPT)]);
      assert.equal(params.resume, undefined);
      assert.match(await promptText(params.prompt), /<conversation_history>[\s\S]*answer two/);
    }

    // No Claude session for this chat: the history goes as text, without the
    // user's memory, on the chat's model.
    {
      const params = await summarize("other", [...older, user(SUMMARY_PROMPT)]);
      assert.equal(params.resume, undefined);
      assert.equal("resumeSessionAt" in params, false);
      assert.equal(params.model, chatParams!.model);
      assert.deepEqual(params.thinking, { type: "disabled" });
      assert.equal(params.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1", "no memory in a text-copy summary");
      assert.match(await promptText(params.prompt), /<conversation_history>[\s\S]*answer two/);
    }
  } finally {
    await h.cleanup();
  }
  console.log("ok — compaction resume regression passed");
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
