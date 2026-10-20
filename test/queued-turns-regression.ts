/**
 * Regression: user messages OpenCode queued while no Claude turn ran for them
 * arrive as consecutive user messages after the last assistant message. All
 * of them must reach Claude as the new turn's prompt — on a resumed session
 * and with history transfer (not duplicated in the transcript) — and the
 * following normal turn must still resume. (Ported from the fork's cf93c7e.)
 *
 * Run: bun test/queued-turns-regression.ts
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { latestUserPrompt, priorMessagesOf } from "../src/prompt.ts";
import type { StartClaudeQueryParams } from "../src/query.ts";
import { assert, mockHandle, startMockedProxy, textDelta } from "./helpers.ts";

const SESSION_ID = "sess-queued";

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
  // Resume requires the Claude transcript on disk.
  const claudeConfig = mkdtempSync(join(tmpdir(), "opencode-claude-queued-cfg-"));
  mkdirSync(join(claudeConfig, "projects", "proj"), { recursive: true });
  writeFileSync(join(claudeConfig, "projects", "proj", `${SESSION_ID}.jsonl`), "");
  process.env.CLAUDE_CONFIG_DIR = claudeConfig;

  const user = (content: unknown) => ({ role: "user", content });
  const assistant = (content: string) => ({ role: "assistant", content });
  const png = "iVBORw0KGgo=";
  const image = { type: "image_url", image_url: { url: `data:image/png;base64,${png}` } };

  // Single message: unchanged, text and multimodal.
  assert.equal(latestUserPrompt([user("u1"), assistant("a1"), user("u2")]), "u2");
  assert.deepEqual(
    latestUserPrompt([user("u1"), assistant("a1"), user([{ type: "text", text: "see" }, image])]),
    {
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "text", text: "see" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: png } },
        ],
      },
      parent_tool_use_id: null,
    },
  );
  // A tool step after the last assistant message falls back to the newest
  // real user message; OpenCode's promoted-media marker is never the prompt.
  assert.equal(
    latestUserPrompt([
      user("ask"),
      { role: "assistant", content: null, tool_calls: [{ id: "c1" }] },
      { role: "tool", tool_call_id: "c1", content: "r" },
      user("Attached media from tool result:"),
    ]),
    "ask",
  );

  // Queued multimodal: every message, in order, attachments in place.
  const queued = latestUserPrompt([
    user("u1"),
    assistant("a1"),
    user("first ask"),
    user([{ type: "text", text: "second ask" }, image]),
    user("third ask"),
  ]);
  assert.ok(typeof queued !== "string");
  assert.deepEqual(
    (queued.message.content as Array<{ type: string; text?: string }>).map(
      (b) => b.text ?? b.type,
    ),
    ["first ask", "second ask", "image", "third ask"],
  );
  assert.deepEqual(
    priorMessagesOf([user("u1"), assistant("a1"), user("q1"), user("q2")]),
    [user("u1"), assistant("a1")],
    "prior history ends before the first queued message",
  );

  const { post, proxy } = await startMockedProxy("queued");

  const calls: Array<{ resume?: string; prompt: string }> = [];
  proxy.setClaudeQueryStarter(async (params) => {
    calls.push({ resume: params.resume, prompt: await promptText(params.prompt) });
    return mockHandle(
      (async function* () {
        yield { type: "system", subtype: "init", session_id: SESSION_ID };
        yield { ...textDelta("ok"), session_id: SESSION_ID };
        yield { type: "result", is_error: false, usage: {}, session_id: SESSION_ID };
      })(),
    );
  });

  const turn = async (session: string, messages: unknown[]) => {
    const res = await post(session, { messages });
    assert.equal(res.status, 200, await res.clone().text());
    return calls.at(-1)!;
  };
  const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

  try {
    // Resumed session: both queued messages are the request.
    await turn("resumed", [user("hello")]);
    const resumed = await turn("resumed", [
      user("hello"),
      assistant("hi"),
      user("QUEUED-ONE"),
      user("QUEUED-TWO"),
    ]);
    assert.equal(resumed.resume, SESSION_ID, "queued turn resumes");
    assert.equal(resumed.prompt, "QUEUED-ONE\n\nQUEUED-TWO");
    const next = await turn("resumed", [
      user("hello"),
      assistant("hi"),
      user("QUEUED-ONE"),
      user("QUEUED-TWO"),
      assistant("both done"),
      user("NEXT"),
    ]);
    assert.equal(next.resume, SESSION_ID, "turn after queued messages resumes");
    assert.equal(next.prompt, "NEXT");

    // History transfer (no session bound yet): queued messages are the
    // request, not history.
    const transferred = await turn("transfer", [
      user("EARLIER-ASK"),
      assistant("EARLIER-ANSWER"),
      user("QUEUED-ONE"),
      user("QUEUED-TWO"),
    ]);
    assert.equal(transferred.resume, undefined);
    const [history, request] = transferred.prompt.split("</conversation_history>");
    assert.match(history!, /EARLIER-ASK[\s\S]*EARLIER-ANSWER/);
    assert.doesNotMatch(history!, /QUEUED/, "queued messages are not history");
    assert.match(request!, /Latest user message:\nQUEUED-ONE\n\nQUEUED-TWO$/);
    assert.equal(occurrences(transferred.prompt, "QUEUED-ONE"), 1);
  } finally {
    proxy.setClaudeQueryStarter(null);
    await proxy.stopProxy();
  }
  console.log("ok — queued turns regression passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
