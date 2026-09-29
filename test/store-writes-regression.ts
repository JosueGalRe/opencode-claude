/** Stable bindings do not rewrite the atomic store; chunked UUID lookup is exact. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import * as store from "../src/session-store.ts";

const tmp = mkdtempSync(join(tmpdir(), "opencode-claude-store-writes-"));
process.env.XDG_DATA_HOME = tmp;
const file = join(tmp, "opencode-claude", "sessions.json");
const compact = () => writeFileSync(file, JSON.stringify(JSON.parse(readFileSync(file, "utf8"))));
const rewritten = () => readFileSync(file, "utf8").includes("\n  ");
try {
  const meta = { cwd: "/p", modelId: "m", leafUuid: "one", history: { count: 0, hash: "empty" } };
  store.setForeignSessionId("chat", "session", meta);
  compact();
  store.setForeignSessionId("chat", "session", meta);
  store.setForeignSessionId("chat", "session", { cwd: "/p", modelId: "m" });
  assert.equal(rewritten(), false);
  store.setForeignSessionId("chat", "session", { ...meta, leafUuid: "two" });
  assert.equal(rewritten(), true);
  assert.equal(store.getSessionLeafUuid("chat"), "two");
  compact();
  store.setHistoryFingerprint("chat", { count: 0, hash: "empty" });
  store.setForeignSessionId("chat", "session", { cwd: "/p", modelId: "m" });
  assert.equal(rewritten(), false, "uncached identical binding is unchanged too");

  store.recordTurnStart("chat", { count: 1, hash: "u1" });
  store.recordTurnStart("chat", { count: 2, hash: "u2" });
  store.setForeignSessionId("chat", "different-session", { cwd: "/p", modelId: "m" });
  assert.equal(store.getSessionLeafUuid("chat"), undefined);
  assert.deepEqual(store.getSessionTurns("chat").map((turn) => turn.leafUuid), [undefined]);
  store.clearForeignSessionId("chat");
  store.setForeignSessionId("chat", "different-session", { cwd: "/p", modelId: "m" });
  assert.equal(store.getForeignSessionId("chat"), "different-session");
  assert.deepEqual(store.getSessionTurns("chat"), []);
  for (let i = 1; i <= 110; i++) store.recordTurnStart("chat", { count: i, hash: String(i) });
  assert.equal(store.getSessionTurns("chat").length, 100);

  // Pending boundaries must not survive a clear (summary before init, failed spawn).
  store.recordTurnStart("pending", { count: 1, hash: "old" });
  store.clearForeignSessionId("pending");
  store.setForeignSessionId("pending", "new");
  assert.deepEqual(store.getSessionTurns("pending"), []);

  const transcript = join(tmp, "transcript.jsonl");
  writeFileSync(transcript, Array.from({ length: 400 }, (_, i) => JSON.stringify({ uuid: `entry-${i}`, pad: "x".repeat(i % 37) })).join("\n"));
  for (const chunk of [7, 64, 1000, 1 << 20]) {
    for (const i of [0, 1, 199, 200, 398, 399]) assert.equal(store.sessionFileHasEntry(transcript, `entry-${i}`, chunk), true);
    assert.equal(store.sessionFileHasEntry(transcript, "entry-400", chunk), false);
    assert.equal(store.sessionFileHasEntry(transcript, "ntry-4", chunk), false);
  }
  assert.equal(store.sessionFileHasEntry(transcript, "entry-1", 0), false);
  assert.equal(store.sessionFileHasEntry(join(tmp, "missing"), "entry-1"), false);
  console.log("ok — store writes regression passed");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
