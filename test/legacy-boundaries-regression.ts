/**
 * Turn boundaries stored before they carried a session id belong to the
 * binding's session. A rewind to one forks that session when its file still
 * holds the leaf; the fork stamps older boundaries with the session they came
 * from. A legacy boundary whose leaf is not in the binding's session (an
 * older build carried it across a session change) can't be forked: the
 * history goes as text.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StartClaudeQueryParams } from "../src/query.ts";
import { userHistoryFingerprints } from "../src/prompt.ts";
import { assert, assistant, mockHandle, promptText, startMockedProxy, textDelta, user } from "./helpers.ts";

const hash = (...texts: string[]) => userHistoryFingerprints(texts.map(user)).at(-1)!;

async function main() {
  const h = await startMockedProxy("legacy-boundaries");
  const { getForeignSessionId, getSessionTurns } = await import("../src/session-store.ts");
  h.append("legacy-a", "A1", "A2", "A3");
  h.append("legacy-b", "B2", "B3");
  // The store as an older build left it: boundaries without sessionId.
  const storeDir = join(h.tmp, "opencode-claude");
  mkdirSync(storeDir, { recursive: true });
  const legacyTurns = (leaves: string[]) => leaves.map((leafUuid, i) => ({
    count: i + 1, hash: hash(...["u1", "u2", "u3"].slice(0, i + 1)), leafUuid,
  }));
  writeFileSync(join(storeDir, "sessions.json"), JSON.stringify({
    a: { conversationKey: "a", foreignSessionId: "legacy-a", leafUuid: "A3", turns: legacyTurns(["A1", "A2", "A3"]), updatedAt: Date.now() },
    // "X1" was carried over from the session before legacy-b.
    b: { conversationKey: "b", foreignSessionId: "legacy-b", leafUuid: "B3", turns: legacyTurns(["X1", "B2", "B3"]), updatedAt: Date.now() },
  }));

  let seen: StartClaudeQueryParams | undefined;
  const send = async (key: string, leaf: string, messages: unknown[]) => {
    h.proxy.setClaudeQueryStarter(async (params) => {
      seen = params;
      const session = params.resume ?? "fresh";
      h.append(session, leaf);
      return mockHandle((async function* () {
        yield { type: "system", subtype: "init", session_id: session };
        yield { type: "assistant", uuid: leaf, session_id: session, parent_tool_use_id: null };
        yield textDelta("ok");
        yield { type: "result", is_error: false, usage: {}, session_id: session };
      })());
    });
    const res = await h.post(key, { messages });
    assert.equal(res.status, 200);
    await res.text();
    return { resume: seen!.resume, transferred: (await promptText(seen!.prompt)).includes("<conversation_history>") };
  };

  try {
    // Legacy boundary in the binding's own session: fork from it.
    let r = await send("a", "N3", [user("u1"), assistant("x"), user("u2"), assistant("y"), user("u3 edited")]);
    assert.deepEqual(r, { resume: "fork-1", transferred: false });
    assert.deepEqual(h.forks, ["legacy-a@A2"]);
    // The fork stamped the older legacy boundary with where it came from.
    assert.deepEqual(getSessionTurns("a").map((t) => `${t.sessionId}:${t.leafUuid}`),
      ["legacy-a:A1", "fork-1:fork-1-A2", "fork-1:N3"]);
    // And a rewind across that fork still forks from legacy-a.
    r = await send("a", "N2", [user("u1"), assistant("x"), user("u2 edited")]);
    assert.deepEqual(r, { resume: "fork-2", transferred: false });
    assert.equal(h.forks.at(-1), "legacy-a@A1");

    // Legacy boundary whose leaf isn't in the binding's session: text.
    r = await send("b", "M2", [user("u1"), assistant("x"), user("u2 edited")]);
    assert.deepEqual(r, { resume: undefined, transferred: true });
    assert.equal(h.forks.length, 2);
    assert.equal(getForeignSessionId("b"), "fresh");
  } finally {
    await h.cleanup();
  }
  console.log("ok — legacy boundaries regression passed");
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
