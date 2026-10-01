/**
 * A chat whose Claude session file holds two branches resumes its own branch
 * through a fork, instead of failing every turn.
 *
 * Seen live upstream (CLI 2.1.285): another claude process on the same
 * session wrote a side branch off a common ancestor, interleaved with our
 * turn, then the last `last-prompt` entry, which names its leaf. The CLI
 * resumes that chain; resumeSessionAt with our leaf searched only there and
 * failed with "No message found with message.uuid of", so every message
 * errored and OpenCode retried in a loop. The fixture has the same shape.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assert, mockHandle, startMockedProxy, textDelta, user, assistant } from "./helpers.ts";

const SESSION = "sess-branched";
const FORK = "sess-branched-fork";

const entry = (type: string, uuid: string, parentUuid: string | null, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type, uuid, parentUuid, sessionId: SESSION, isSidechain: false, ...extra });
const meta = (type: string, extra: Record<string, unknown> = {}) => JSON.stringify({ type, sessionId: SESSION, ...extra });

// `common` is where the branches split; ours ends at `leaf`, the other at `side-3`.
const BRANCHED = [
  entry("user", "u-root", null),
  entry("assistant", "a-prev", "u-root"),
  entry("user", "u-prompt", "a-prev"),
  entry("attachment", "common", "u-prompt"),
  meta("last-prompt", { leafUuid: "common" }),
  meta("ai-title", { aiTitle: "t" }),
  entry("assistant", "ours-1", "common"),
  entry("assistant", "ours-2", "ours-1"),
  meta("last-prompt", { leafUuid: "ours-2" }),
  entry("assistant", "side-1", "common"),
  entry("assistant", "side-2", "side-1"),
  entry("assistant", "side-3", "side-2"),
  entry("user", "ours-3", "ours-2", { message: { content: "ñandú — multi-byte text across chunk borders" } }),
  entry("attachment", "ours-4", "ours-3"),
  entry("assistant", "ours-5", "ours-4"),
  entry("assistant", "leaf", "ours-5"),
  entry("system", "hook", "leaf", { subtype: "stop_hook_summary" }),
  meta("last-prompt", { leafUuid: "hook" }),
  meta("cost-state"),
  meta("last-prompt", { leafUuid: "side-3" }),
  meta("cost-state"),
  "",
].join("\n");
const WITHOUT_SIDE_PROMPT = BRANCHED.replace(/.*"leafUuid":"side-3".*\n/, "");

async function main() {
  const h = await startMockedProxy("branched");
  const { getForeignSessionId, getSessionLeafUuid, lastChainEntryUuid, sessionChainAfterLeaf, setForeignSessionId } =
    await import("../src/session-store.ts");
  const projectDir = join(h.tmp, "claude", "projects", "proj");
  mkdirSync(projectDir, { recursive: true });
  const sessionFile = join(projectDir, `${SESSION}.jsonl`);
  writeFileSync(sessionFile, BRANCHED);

  // The decision itself, whatever the chunk size.
  for (const chunk of [7, 16, 64, 256 * 1024]) {
    assert.equal(sessionChainAfterLeaf(sessionFile, "leaf", chunk), "branched");
    assert.equal(sessionChainAfterLeaf(sessionFile, "missing-uuid", chunk), "missing");
    assert.equal(sessionChainAfterLeaf(sessionFile, "ours-3", chunk), "branched");
    assert.equal(lastChainEntryUuid(sessionFile, chunk), "leaf");
  }
  const scratch = join(projectDir, "scratch.jsonl");
  writeFileSync(scratch, WITHOUT_SIDE_PROMPT);
  assert.equal(sessionChainAfterLeaf(scratch, "leaf"), "clean");
  // A message after the leaf off another parent is a branch too.
  writeFileSync(scratch, WITHOUT_SIDE_PROMPT + entry("user", "late", "side-3") + "\n");
  assert.equal(sessionChainAfterLeaf(scratch, "leaf"), "branched");
  // Sidechain (subagent) entries don't count.
  writeFileSync(scratch, WITHOUT_SIDE_PROMPT + entry("user", "sub", "elsewhere", { isSidechain: true }) + "\n");
  assert.equal(sessionChainAfterLeaf(scratch, "leaf"), "clean");
  // A compaction continues the chain through logicalParentUuid.
  writeFileSync(scratch, [
    entry("assistant", "leaf", "x"),
    JSON.stringify({ type: "system", subtype: "compact_boundary", uuid: "cb", parentUuid: null, logicalParentUuid: "leaf" }),
    entry("user", "summary", "cb"),
    "",
  ].join("\n"));
  assert.equal(sessionChainAfterLeaf(scratch, "leaf"), "clean");
  assert.equal(lastChainEntryUuid(scratch, 5), "summary");
  writeFileSync(scratch, meta("last-prompt") + "\n");
  assert.equal(lastChainEntryUuid(scratch), undefined);

  try {
    const forks: string[] = [];
    h.proxy.setClaudeSessionForker(async (id, at) => {
      forks.push(`${id}@${at}`);
      writeFileSync(join(projectDir, `${FORK}.jsonl`),
        [entry("user", "f-root", null), entry("assistant", "f-leaf", "f-root"), meta("last-prompt", { leafUuid: "f-leaf" }), ""].join("\n"));
      return FORK;
    });
    let seen: Record<string, unknown> = {};
    h.proxy.setClaudeQueryStarter(async (params) => {
      seen = params as unknown as Record<string, unknown>;
      return mockHandle((async function* () {
        yield { type: "system", subtype: "init", session_id: FORK };
        yield { type: "assistant", uuid: "next", session_id: FORK, parent_tool_use_id: null };
        yield textDelta("ok");
        yield { type: "result", is_error: false, usage: {}, session_id: FORK };
      })());
    });

    // A chat bound before this fix, stuck on the branched file: the next
    // message heals it through a fork cut at its leaf.
    setForeignSessionId("stuck-chat", SESSION, { leafUuid: "leaf" });
    const res = await h.post("stuck-chat", { messages: [user("first"), assistant("answer"), user("next")] });
    assert.equal(res.status, 200);
    await res.text();
    assert.deepEqual(forks, [`${SESSION}@leaf`]);
    assert.equal(seen.resume, FORK);
    assert.equal("resumeSessionAt" in seen, false);
    assert.doesNotMatch(String(seen.prompt), /<conversation_history>/);
    assert.equal(getForeignSessionId("stuck-chat"), FORK);
    assert.equal(getSessionLeafUuid("stuck-chat"), "next");

    // A fork that fails transfers the history instead of retrying it.
    h.proxy.setClaudeSessionForker(async () => { throw new Error("fork failed"); });
    setForeignSessionId("forkfail-chat", SESSION, { leafUuid: "leaf" });
    await (await h.post("forkfail-chat", { messages: [user("first"), assistant("answer"), user("next")] })).text();
    assert.equal(seen.resume, undefined);
    assert.match(String(seen.prompt), /<conversation_history>/);

    // Should the CLI still say it can't find a message, the binding goes, so
    // OpenCode's retry transfers the history instead of failing again.
    writeFileSync(sessionFile, WITHOUT_SIDE_PROMPT);
    setForeignSessionId("nomsg-chat", SESSION, { leafUuid: "hook" });
    h.proxy.setClaudeQueryStarter(async () => mockHandle((async function* () {
      yield {
        type: "result", subtype: "error_during_execution", is_error: true,
        errors: ["No message found with message.uuid of: hook"],
      };
    })()));
    await (await h.post("nomsg-chat", { stream: true, messages: [user("hi")] })).text();
    assert.equal(getForeignSessionId("nomsg-chat"), undefined);
    assert.equal(forks.length, 1);
  } finally {
    await h.cleanup();
  }
  console.log("ok — branched session regression passed");
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
