/** Compaction's leaf is its synthetic summary, never its boundary or stdout replay. */
import type { StartClaudeQueryParams } from "../src/query.ts";
import { assert, assistant, mockHandle, startMockedProxy, textDelta, user } from "./helpers.ts";

async function main() {
  const h = await startMockedProxy("compact-leaf");
  const { getSessionLeafUuid } = await import("../src/session-store.ts");
  const calls: StartClaudeQueryParams[] = [];
  h.transcript("session", ["pre-compact", "boundary", "summary", "subagent"]);
  h.proxy.setClaudeQueryStarter(async (params) => {
    calls.push(params);
    return mockHandle((async function* () {
      yield { type: "system", subtype: "init", session_id: "session" };
      yield { type: "assistant", uuid: "pre-compact", session_id: "session" };
      yield { type: "system", subtype: "compact_boundary", uuid: "boundary", session_id: "session" };
      yield { type: "user", uuid: "summary", isSynthetic: true, session_id: "session" };
      yield { type: "user", uuid: "stdout", isReplay: true, session_id: "session" };
      yield { type: "assistant", uuid: "subagent", parent_tool_use_id: "task", session_id: "session" };
      yield textDelta("partial");
      yield { type: "result", is_error: true, errors: ["API Error: 500 boom"], session_id: "session" };
    })());
  });
  try {
    await (await h.post("chat", { messages: [user("long task")] })).text();
    assert.equal(getSessionLeafUuid("chat"), "summary");
    await (await h.post("chat", { messages: [user("long task"), assistant("partial"), user("next")] })).text();
    // Everything after the summary descends from it: a plain resume, no fork.
    assert.equal(calls.at(-1)?.resume, "session");
    assert.equal("resumeSessionAt" in calls.at(-1)!, false);
    assert.deepEqual(h.forks, []);
  } finally {
    await h.cleanup();
  }
  console.log("ok — compact leaf regression passed");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
