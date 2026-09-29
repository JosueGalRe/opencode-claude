/** Native reverts first; the fork's content check applies to the selected branch. */
import type { StartClaudeQueryParams } from "../src/query.ts";
import { z } from "zod";
import { userHistoryFingerprints } from "../src/prompt.ts";
import { matchTurnHistory } from "../src/session-store.ts";
import { assert, assistant, bashTool, callTool, mockHandle, promptText, result, startMockedProxy, textDelta, user } from "./helpers.ts";

async function main() {
  const h = await startMockedProxy("revert-edit");
  const store = await import("../src/session-store.ts");
  const leaves: string[] = [];
  const seen: StartClaudeQueryParams[] = [];
  let leaf = "";
  const answering = async (params: StartClaudeQueryParams) => {
    seen.push(params);
    leaves.push(leaf);
    h.transcript("session", leaves);
    return mockHandle((async function* () {
      yield { type: "system", subtype: "init", session_id: "session" };
      yield { type: "assistant", uuid: leaf, session_id: "session", parent_tool_use_id: null };
      yield textDelta("answer");
      yield result;
    })());
  };
  h.proxy.setClaudeQueryStarter(answering);
  const turn = async (name: string, messages: unknown[], extra = {}) => {
    leaf = name;
    const res = await h.post("chat", { messages, ...extra });
    assert.equal(res.status, 200, await res.clone().text());
    await res.text();
    const params = seen.at(-1);
    assert.ok(params);
    return {
      resume: params.resume,
      // Access through `in` so the original fork runs the regression red.
      at: "resumeSessionAt" in params ? params.resumeSessionAt : undefined,
      transferred: (await promptText(params.prompt)).includes("<conversation_history>"),
    };
  };
  const resumed = (at: string) => ({ resume: "session", at, transferred: false });
  try {
    const reminder = user("<system-reminder>Plan mode</system-reminder>");
    assert.deepEqual(userHistoryFingerprints([user("one"), reminder, user("two")]),
      userHistoryFingerprints([user("one"), user("two"), reminder]));
    assert.deepEqual(userHistoryFingerprints([user("one")]), userHistoryFingerprints([user([{ type: "text", text: " one " }])]));
    assert.equal(userHistoryFingerprints([user("ask"), { role: "tool" }, user([{ type: "image_url" }])]).length, 1);
    const boundaries = [{ count: 1, hash: "h1", leafUuid: "L1" }, { count: 2, hash: "h2", leafUuid: "L2" }];
    assert.deepEqual(matchTurnHistory([], []), { kind: "untracked" });
    assert.deepEqual(matchTurnHistory(boundaries, ["h1"]), { kind: "rewind", index: 0, leafUuid: "L1" });
    assert.deepEqual(matchTurnHistory(boundaries, ["h1", "h2", "h3"]), { kind: "latest" });
    assert.deepEqual(matchTurnHistory(boundaries, ["edited", "h2"]), { kind: "diverged" });

    const first = [user("u1"), assistant("a1")];
    const second = [...first, user("u2"), assistant("a2")];
    await turn("L1", [user("u1")]);
    await turn("L2", [...first, user("u2")]);
    await turn("L3", [...second, user("u3")]);

    // Given three completed turns, reverting the last one keeps native context.
    assert.deepEqual(await turn("L3b", [...second, user("u3 edited")]), resumed("L2"));
    assert.deepEqual(await turn("L4", [...second, user("u3 edited"), assistant("a3b"), user("u4")]), resumed("L3b"));
    assert.deepEqual(await turn("L2b", [...first, user("u2 edited")]), resumed("L1"));
    assert.deepEqual(await turn("L2c", [...first, user("u2 edited")]), resumed("L1"), "retry rewinds before its prompt");
    assert.deepEqual(await turn("L3c", [...first, user("u2 edited"), assistant("a2c"), user("u3")], { model: "opus" }), resumed("L2c"));

    // Same users, rewritten non-user history: boundary match cannot bypass DCP.
    const rewritten = [user("u1"), assistant("pruned"), user("u2 edited"), assistant("a2c"), user("u3"), assistant("a3c")];
    assert.deepEqual(await turn("DCP", [...rewritten, user("u4")]), { resume: undefined, at: undefined, transferred: true });
    process.env.OPENCODE_CLAUDE_HOST_TRANSCRIPT = "0";
    const changed = [user("u1"), assistant("rewritten again"), ...rewritten.slice(2), user("u4"), assistant("a4")];
    assert.deepEqual(await turn("OFF", [...changed, user("u5")]), resumed("DCP"));
    // The preference must not disable edit detection or pinned resume.
    assert.deepEqual(await turn("EDIT", [user("edited u1"), ...changed.slice(1), user("u5"), assistant("a5"), user("u6")]), { resume: undefined, at: undefined, transferred: true });
    delete process.env.OPENCODE_CLAUDE_HOST_TRANSCRIPT;

    // A rewind also checks the completed earlier branch's content checkpoint.
    store.clearForeignSessionId("chat");
    await turn("R1", [user("u1")]);
    await turn("R2", [...first, user("u2")]);
    await turn("R3", [...second, user("u3")]);
    assert.deepEqual(await turn("RDCP", [user("u1"), assistant("pruned a1"), user("replacement")]),
      { resume: undefined, at: undefined, transferred: true });

    // Plan reminders move before/after the prompt and can be embedded in it.
    store.clearForeignSessionId("chat");
    await turn("P1", [user("u1")]);
    assert.deepEqual(await turn("P2", [...first, reminder, user("plan")]), resumed("P1"));
    const planned = [...first, user("plan"), reminder, assistant("plan answer")];
    assert.deepEqual(await turn("P3", [...planned, user("go")]), resumed("P2"));
    const inline = [user("u1<system-reminder>Build mode</system-reminder>"), ...planned.slice(1), user("go"), assistant("done")];
    assert.deepEqual(await turn("P4", [...inline, user("next")]), resumed("P3"));
    const beforeMeta = store.getSessionBinding("chat");
    for (const kind of ["title", "generate"]) {
      await (await h.post("chat", { messages: [user("utility")] }, { "x-opencode-claude-request-kind": kind })).text();
      assert.deepEqual(store.getSessionBinding("chat"), beforeMeta);
      assert.equal(seen.at(-1)?.resume, undefined);
    }

    // Rewrite during a tool continuation: finish the same turn, but do not
    // accept the rewritten prefix as a new baseline when forwarding steering.
    const ask = [...inline, user("next"), assistant("answer"), user("list files")];
    h.proxy.setClaudeQueryStarter(async (params) => {
      seen.push(params);
      leaves.push("TOOL", "DONE");
      h.transcript("session", leaves);
      return mockHandle((async function* () {
        yield { type: "system", session_id: "session" };
        yield { type: "assistant", uuid: "TOOL", session_id: "session" };
        await callTool(params);
        yield { type: "assistant", uuid: "DONE", session_id: "session" };
        yield textDelta("done");
        yield result;
      })());
    });
    const parked = await h.post("chat", { messages: ask, tools: [bashTool] });
    const completion = z.object({ choices: z.array(z.object({ message: z.object({
      tool_calls: z.array(z.object({ id: z.string(), type: z.string(), function: z.object({ name: z.string(), arguments: z.string() }) })),
    }) })) }).parse(await parked.json());
    const call = completion.choices[0]?.message.tool_calls[0];
    assert.ok(call);
    const spawns = seen.length;
    const rewrittenStep = [ask[0], assistant("DCP pruned answer"), ...ask.slice(2),
      { role: "assistant", tool_calls: [call], content: null },
      { role: "tool", tool_call_id: call.id, content: "files" }, user("also count")];
    await (await h.post("chat", { messages: rewrittenStep, tools: [bashTool] })).text();
    assert.equal(seen.length, spawns, "continuation never spawns another turn");
    assert.equal(store.getSessionLeafUuid("chat"), "DONE");
    h.proxy.setClaudeQueryStarter(answering);
    assert.deepEqual(await turn("AFTER-DCP", [...rewrittenStep, assistant("done"), user("thanks")]),
      { resume: undefined, at: undefined, transferred: true });

    // A recorded rewind point removed from the transcript cannot silently
    // resume the latest (wrong) branch. This differs from a missing current leaf.
    store.clearForeignSessionId("chat");
    await turn("M1", [user("u1")]);
    await turn("M2", [...first, user("u2")]);
    h.transcript("session", ["M2"]);
    assert.deepEqual(await turn("M3", [...first, user("replacement")]),
      { resume: undefined, at: undefined, transferred: true });
  } finally {
    delete process.env.OPENCODE_CLAUDE_HOST_TRANSCRIPT;
    await h.cleanup();
  }
  console.log("ok — revert/edit regression passed");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
