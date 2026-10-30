/**
 * Regression (#70): with background compaction OpenCode writes the summary
 * while the chat goes on, often with its turn parked on a tool call. The
 * summary stopped that turn and dropped the chat's Claude session, so the
 * chat started one fresh session right away and another when the summary
 * was swapped in, each re-reading the whole context.
 * - The summary leaves the live turn running and the binding in place.
 * - It resumes the session at the end of the turn before the live one (the
 *   live turn ends on an unanswered call no resume can cut at) and reads the
 *   live turn's messages, results included, as text.
 * - The summary's tool results never resolve the chat's parked turn; the
 *   chat's own continuation does.
 *
 * Run: bun test/compaction-live-turn-regression.ts
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StartClaudeQueryParams } from "../src/query.ts";
import { assert, bashTool, callTool, interruptibleTurn, mockHandle, startMockedProxy, textDelta } from "./helpers.ts";

const SESSION = "live-sess";
const SUMMARY_PROMPT = "Create a detailed summary for continuing this coding session.";

async function promptText(prompt: StartClaudeQueryParams["prompt"]): Promise<string> {
  if (typeof prompt === "string") return prompt;
  for await (const part of prompt) {
    const content = (part as { message?: { content?: unknown } }).message?.content;
    return typeof content === "string" ? content : JSON.stringify(content);
  }
  return "";
}

async function main() {
  const claudeConfig = mkdtempSync(join(tmpdir(), "opencode-claude-live-cfg-"));
  process.env.CLAUDE_CONFIG_DIR = claudeConfig;
  const projectDir = join(claudeConfig, "projects", "proj");
  mkdirSync(projectDir, { recursive: true });
  // Turn 1 ends at T1; the live turn's call hangs off it, unanswered.
  writeFileSync(
    join(projectDir, `${SESSION}.jsonl`),
    [
      { type: "assistant", uuid: "T1", parentUuid: null },
      { type: "assistant", uuid: "A2", parentUuid: "T1" },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n",
  );

  const { post, proxy } = await startMockedProxy("compaction-live");
  const { getForeignSessionId } = await import("../src/session-store.ts");
  const log: string[] = [];
  let summary: StartClaudeQueryParams | null = null;
  let spawns = 0;
  proxy.setClaudeQueryStarter(async (params) => {
    if (params.persistSession === false) {
      summary = params;
      return mockHandle(
        (async function* () {
          yield textDelta("## Objective\n- the summary");
          yield { type: "result", is_error: false, usage: {} };
        })(),
      );
    }
    spawns += 1;
    if (spawns === 1) {
      return mockHandle(
        (async function* () {
          yield { type: "system", subtype: "init", session_id: SESSION };
          yield { type: "assistant", uuid: "T1", session_id: SESSION, parent_tool_use_id: null, message: { content: [] } };
          yield { ...textDelta("hi"), session_id: SESSION };
          yield { type: "result", is_error: false, usage: {}, session_id: SESSION };
        })(),
      );
    }
    return interruptibleTurn(
      log,
      "turn",
      async function* () {
        yield { type: "system", subtype: "init", session_id: SESSION };
        yield { type: "assistant", uuid: "A2", session_id: SESSION, parent_tool_use_id: null, message: { content: [] } };
        await callTool(params, "bash", { command: "rg needle" });
        log.push("turn:resumed");
        yield { ...textDelta("found it"), session_id: SESSION };
        yield { type: "result", is_error: false, usage: {}, session_id: SESSION };
      },
      { sessionId: SESSION },
    );
  });

  const turn1 = [{ role: "user", content: "hello" }];
  await (await post("chat", { tools: [bashTool], messages: turn1 })).json();
  const live = [...turn1, { role: "assistant", content: "hi" }, { role: "user", content: "find the needle" }];
  const first = (await (await post("chat", { tools: [bashTool], messages: live })).json()) as any;
  assert.equal(first.choices[0].finish_reason, "tool_calls");
  const call = first.choices[0].message.tool_calls[0];
  const step = [
    ...live,
    { role: "assistant", content: null, tool_calls: [call] },
    { role: "tool", tool_call_id: call.id, content: "src/needle.ts:1" },
  ];

  // The background summary, written while the turn waits on its tool.
  const res = await post("chat", {
    tools: [bashTool],
    messages: [...step, { role: "user", content: SUMMARY_PROMPT }],
  });
  assert.equal(res.status, 200);
  assert.match(((await res.json()) as any).choices[0].message.content, /the summary/);
  assert.ok(!log.includes("turn:interrupt"), "the live turn keeps running");
  assert.ok(!log.includes("turn:resumed"), "the summary's results don't resolve the chat's turn");
  assert.equal(getForeignSessionId("chat"), SESSION, "the binding stays");
  const params = summary as StartClaudeQueryParams | null;
  assert.ok(params, "the summary ran");
  assert.equal(params!.resume, SESSION);
  assert.equal(params!.resumeSessionAt, "T1", "resumes at the end of the turn before the live one");
  const text = await promptText(params!.prompt);
  assert.match(text, /find the needle[\s\S]*src\/needle\.ts:1/, "the live turn is read as text");
  assert.ok(text.includes(SUMMARY_PROMPT));

  // The chat goes on with its full history: the parked turn continues, no
  // new Claude session.
  const spawnsBefore = spawns;
  const next = (await (await post("chat", { tools: [bashTool], messages: step })).json()) as any;
  assert.match(next.choices[0].message.content, /found it/);
  assert.ok(log.includes("turn:resumed"), "the chat's own results resolve its turn");
  assert.equal(spawns, spawnsBefore, "no new Claude session for the chat");

  console.log("compaction-live-turn regression ok");
  await proxy.stopProxy?.();
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
