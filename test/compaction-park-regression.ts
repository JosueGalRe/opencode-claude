/**
 * Regression: OpenCode compacts a chat whose turn is parked on a tool call.
 * The parked turn belongs to the uncompacted Claude session. Left alive, it
 * re-emitted its call to every continuation of the compacted chat, with the
 * old context size, and OpenCode compacted again, over and over. The summary
 * leaves the turn alone (background compaction writes it while the chat goes
 * on); the continuation carrying the compacted history stops it and starts a
 * new one.
 *
 * Run: bun test/compaction-park-regression.ts
 */
import {
  assert,
  bashTool,
  callTool,
  interruptibleTurn,
  startMockedProxy,
  textDelta,
} from "./helpers.ts";

async function main() {
  const keepAlive = setInterval(() => {}, 1000);
  const { post, proxy } = await startMockedProxy("compaction-park");
  try {
    const log: string[] = [];
    proxy.setClaudeQueryStarter(async (params) => {
      log.push("turn:spawn");
      return interruptibleTurn(log, "turn", async function* () {
        yield { type: "system", subtype: "init", session_id: "compact-sess" };
        callTool(params, "bash", { command: "ls" }).catch(() => {});
        await new Promise(() => {});
      }, { settleMs: 300 });
    });
    const first = await post("compact-park", {
      tools: [bashTool],
      messages: [{ role: "user", content: "run it" }],
    });
    assert.equal(((await first.json()) as any).choices[0].finish_reason, "tool_calls");

    proxy.setClaudeQueryStarter(async () => {
      log.push("summary:spawn");
      return interruptibleTurn(log, "summary", async function* () {
        yield textDelta("the summary");
        yield { type: "result", is_error: false, usage: {} };
      });
    });
    const summary = await post("compact-park", {
      messages: [
        { role: "user", content: "run it" },
        { role: "user", content: "Create a detailed summary for continuing this coding session." },
      ],
    });
    assert.equal(summary.status, 200);
    await summary.text();
    // Background compaction writes the summary while the chat goes on, so
    // the summary leaves the parked turn alone.
    assert.ok(!log.includes("turn:interrupt"), "the summary does not stop the chat's turn");

    proxy.setClaudeQueryStarter(async () => {
      log.push("next:spawn");
      return interruptibleTurn(log, "next", async function* () {
        yield textDelta("continuing");
        yield { type: "result", is_error: false, usage: {} };
      });
    });
    const next = await post("compact-park", {
      tools: [bashTool],
      messages: [
        { role: "user", content: "What did we do so far?\n\nthe summary" },
        { role: "user", content: "Continue if you have next steps" },
      ],
    });
    const body = (await next.json()) as any;
    assert.equal(body.choices[0].finish_reason, "stop", "no stale tool call re-emitted");
    assert.ok(log.includes("turn:interrupt"), "the compacted history stops the parked turn");
    assert.ok(log.includes("next:spawn"), "continuation ran as a new turn");
    console.log("compaction-park regression ok");
  } finally {
    clearInterval(keepAlive);
    await proxy.stopProxy?.();
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
