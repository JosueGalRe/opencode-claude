/** Cwd changes and legacy entries resume; a missing current leaf falls back to plain resume. */
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import type { StartClaudeQueryParams } from "../src/query.ts";
import { assert, assistant, mockHandle, result, startMockedProxy, textDelta, user } from "./helpers.ts";

async function main() {
  const h = await startMockedProxy("cwd-resume");
  const store = await import("../src/session-store.ts");
  const calls: StartClaudeQueryParams[] = [];
  const messages = [user("first"), assistant("answer"), user("second")];
  h.proxy.setClaudeQueryStarter(async (params) => {
    calls.push(params);
    return mockHandle((async function* () { yield textDelta("ok"); yield result; })());
  });
  try {
    h.transcript("session", ["leaf", "later-orphan-branch"]);
    store.setForeignSessionId("moved", "session", { cwd: "/old", leafUuid: "leaf" });
    const res = await h.post("moved", { messages }, { "x-opencode-claude-directory": "/new" });
    assert.equal(res.status, 200);
    await res.text();
    assert.equal(calls.at(-1)?.cwd, "/new");
    assert.equal(calls.at(-1)?.resume, "session");
    assert.equal(calls.at(-1)?.resumeSessionAt, "leaf");
    assert.doesNotMatch(String(calls.at(-1)?.prompt), /<conversation_history>/);

    // The stored current leaf has been compacted away: upstream plain-resume fallback.
    store.setForeignSessionId("missing-leaf", "session", { leafUuid: "gone" });
    await (await h.post("missing-leaf", { messages })).text();
    assert.equal(calls.at(-1)?.resume, "session");
    assert.equal(calls.at(-1)?.resumeSessionAt, undefined);

    // A pre-upgrade file has neither leaves nor boundaries nor host fingerprints.
    const dir = join(h.tmp, "opencode-claude");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "sessions.json"), JSON.stringify({ legacy: {
      conversationKey: "legacy", foreignSessionId: "session", cwd: "/old", updatedAt: Date.now(),
    } }));
    await (await h.post("legacy", { messages })).text();
    assert.equal(calls.at(-1)?.resume, "session");
    assert.equal(calls.at(-1)?.resumeSessionAt, undefined);
    assert.doesNotMatch(String(calls.at(-1)?.prompt), /<conversation_history>/);
  } finally {
    await h.cleanup();
  }
  console.log("ok — cwd resume regression passed");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
