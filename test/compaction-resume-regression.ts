/**
 * Regression: OpenCode's compaction summary was written by haiku from a
 * text copy of the chat cut to 400k characters, with every tool result cut
 * to 1000. On a long chat it saw a fraction of the conversation. The summary
 * now resumes an in-memory fork of the chat's Claude session, cut where the
 * summarized part ends, on the chat's model with the chat turn's system
 * prompt and tools (same prompt cache), and nothing is written to it.
 * - A reminder after a reply that missed the template resumes at the same
 *   point with the summary prompt.
 * - A chat with no resumable session gets the history as text, sized to the
 *   chat model, still on the chat's model.
 *
 * Run: bun test/compaction-resume-regression.ts
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StartClaudeQueryParams } from "../src/query.ts";
import { assert, bashTool, mockHandle, startMockedProxy, textDelta } from "./helpers.ts";

const user = (content: string) => ({ role: "user", content });
const assistant = (content: string) => ({ role: "assistant", content });
const SUMMARY_PROMPT = "Create a detailed summary for continuing this coding session.";
const NUDGE =
  "The previous response did not fill in the required summary template. Do not call tools.";

async function promptText(prompt: StartClaudeQueryParams["prompt"]): Promise<string> {
  if (typeof prompt === "string") return prompt;
  let text = "";
  for await (const part of prompt) {
    const content = (part as { message?: { content?: unknown } }).message?.content;
    text += typeof content === "string" ? content : JSON.stringify(content);
    // A chat turn's input stays open while the turn runs: only the first
    // message is the prompt.
    break;
  }
  return text;
}

async function main() {
  const claudeConfig = mkdtempSync(join(tmpdir(), "opencode-claude-compact-cfg-"));
  process.env.CLAUDE_CONFIG_DIR = claudeConfig;
  const projectDir = join(claudeConfig, "projects", "proj");
  mkdirSync(projectDir, { recursive: true });
  const files = new Map<string, string[]>();
  const append = (session: string, uuid: string) => {
    const uuids = [...(files.get(session) ?? []), uuid];
    files.set(session, uuids);
    writeFileSync(
      join(projectDir, `${session}.jsonl`),
      uuids
        .map((u, i) => JSON.stringify({ type: "assistant", uuid: u, parentUuid: i > 0 ? uuids[i - 1] : null }))
        .join("\n") + "\n",
    );
  };

  const { post, proxy } = await startMockedProxy("compaction-resume");
  const { getForeignSessionId } = await import("../src/session-store.ts");

  let seen: StartClaudeQueryParams | null = null;
  let chatParams: StartClaudeQueryParams | null = null;
  let fresh = 0;
  proxy.setClaudeQueryStarter(async (params) => {
    seen = params;
    const summary = params.persistSession === false;
    if (!summary) chatParams = params;
    const session = params.resume ?? (summary ? "none" : `chat-sess-${++fresh}`);
    const leaf = `L${(files.get(session) ?? []).length + 1}`;
    if (!summary) append(session, leaf);
    return mockHandle(
      (async function* () {
        yield { type: "system", subtype: "init", session_id: summary ? "fork-sess" : session };
        if (!summary) {
          yield { type: "assistant", uuid: leaf, session_id: session, parent_tool_use_id: null, message: { content: [] } };
        }
        yield textDelta(summary ? "## Objective\n- the summary" : `answer ${leaf}`);
        yield { type: "result", is_error: false, usage: {}, session_id: session };
      })(),
    );
  });

  const turn = async (messages: unknown[]) => {
    const res = await post("chat", { tools: [bashTool], messages });
    assert.equal(res.status, 200);
    await res.text();
  };
  const h1 = [user("one")];
  const h2 = [...h1, assistant("answer L1"), user("two")];
  const h3 = [...h2, assistant("answer L2"), user("three")];
  await turn(h1);
  await turn(h2);
  await turn(h3);
  assert.equal(getForeignSessionId("chat"), "chat-sess-1");

  // OpenCode keeps "three" verbatim and summarizes the turns before it.
  const older = [...h2, assistant("answer L2")];
  const summarize = async (session: string, messages: unknown[]) => {
    seen = null;
    const res = await post(session, { tools: [bashTool], messages });
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.match(body.choices[0].message.content, /the summary/);
    return seen!;
  };

  {
    const params = await summarize("chat", [...older, user(SUMMARY_PROMPT)]);
    assert.equal(params.resume, "chat-sess-1", "resumes the chat's Claude session");
    assert.equal(params.resumeSessionAt, "L2", "cut where the summarized part ends");
    assert.equal(params.forkSession, true);
    assert.equal(params.persistSession, false, "nothing written to the session");
    assert.equal(params.model, chatParams!.model, "the chat's model, not haiku");
    assert.deepEqual(params.systemPrompt, chatParams!.systemPrompt, "same system prompt as the chat turn");
    assert.ok(params.mcpServers, "same tools as the chat turn");
    assert.equal(params.permissionMode, "dontAsk", "tool calls are refused");
    assert.equal(params.allowedTools, undefined);
    assert.equal(params.autoCompactEnabled, false);
    assert.equal(params.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY, undefined, "keeps the chat's memory");
    const text = await promptText(params.prompt);
    assert.ok(text.includes(SUMMARY_PROMPT));
    assert.ok(!text.includes("<conversation_history>"), "no text copy of the chat");
    assert.equal(getForeignSessionId("chat"), undefined, "the chat starts a new session after compaction");
  }

  // Same chat again, with a reminder after a reply that missed the template.
  await turn(h1);
  await turn(h2);
  await turn(h3);
  {
    const params = await summarize("chat", [
      ...older,
      user(SUMMARY_PROMPT),
      assistant("not a summary"),
      user(NUDGE),
    ]);
    assert.equal(params.resumeSessionAt, "L2");
    const text = await promptText(params.prompt);
    assert.ok(text.includes(SUMMARY_PROMPT), "the summary prompt, not only the reminder");
    assert.ok(!text.includes(NUDGE));
  }

  // No Claude session for this chat: the history goes as text, on the chat's model.
  {
    const params = await summarize("other", [...older, user(SUMMARY_PROMPT)]);
    assert.equal(params.resume, undefined);
    assert.equal(params.model, chatParams!.model);
    assert.equal(params.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1", "no memory in a text-copy summary");
    const text = await promptText(params.prompt);
    assert.ok(text.includes("<conversation_history>"));
    assert.ok(text.includes("answer L2"));
  }

  console.log("compaction-resume regression ok");
  await proxy.stopProxy?.();
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
