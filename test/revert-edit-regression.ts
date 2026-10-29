/**
 * Regression: reverting or editing in OpenCode rewinds the Claude session
 * instead of resuming a history OpenCode no longer has.
 * - History back at an earlier turn → a fork cut at that turn's leaf,
 *   resumed plainly. Boundaries from before a fork are dropped; going back
 *   to one transfers the history.
 * - History that matches no turn → binding dropped, history transferred.
 * - Normal flows never misfire: follow-ups, a retried request, a model
 *   switch, tool-result continuations, steering, a rebuilt tool step, Plan
 *   mode reminders moving around, title requests.
 *
 * Run: bun test/revert-edit-regression.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { userHistoryFingerprints } from "../src/prompt.ts";
import { matchTurnHistory } from "../src/session-store.ts";
import type { StartClaudeQueryParams } from "../src/query.ts";
import { assert, bashTool, callTool, mockHandle, startMockedProxy, textDelta } from "./helpers.ts";

const SESSION = "sess-revert";

const user = (content: unknown) => ({ role: "user", content });
const assistant = (content: string) => ({ role: "assistant", content });

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
  // Fingerprints: user messages only, reminders and promoted media skipped.
  {
    const reminder = user("<system-reminder>\nYou are in Plan mode.\n</system-reminder>");
    const a = userHistoryFingerprints([user("one"), assistant("x"), reminder, user("two")]);
    const b = userHistoryFingerprints([user("one"), assistant("y"), user("two"), reminder]);
    assert.equal(a.length, 2);
    assert.deepEqual(a, b);
    assert.deepEqual(
      userHistoryFingerprints([user([{ type: "text", text: "one" }])]),
      userHistoryFingerprints([user("  one ")]),
    );
    assert.equal(
      userHistoryFingerprints([
        user("ask"),
        { role: "assistant", content: null, tool_calls: [{ id: "c1" }] } as any,
        { role: "tool", tool_call_id: "c1", content: "r" },
        user("Attached media from tool result:"),
      ]).length,
      1,
    );
    const turns = [
      { count: 1, hash: "h1", leafUuid: "L1" },
      { count: 2, hash: "h2", leafUuid: "L2" },
    ];
    assert.deepEqual(matchTurnHistory([], ["h1"]), { kind: "untracked" });
    assert.deepEqual(matchTurnHistory(turns, ["h1", "h2"]), { kind: "latest", count: 2 });
    assert.deepEqual(matchTurnHistory(turns, ["h1", "h2", "h3"]), { kind: "latest", count: 2 });
    assert.deepEqual(matchTurnHistory(turns, ["h1"]), { kind: "rewind", index: 0, leafUuid: "L1" });
    assert.deepEqual(matchTurnHistory(turns, []), { kind: "diverged" });
    assert.deepEqual(matchTurnHistory(turns, ["hx", "h2x"]), { kind: "diverged" });
  }

  const claudeConfig = mkdtempSync(join(tmpdir(), "opencode-claude-revert-cfg-"));
  process.env.CLAUDE_CONFIG_DIR = claudeConfig;
  const projectDir = join(claudeConfig, "projects", "proj");
  mkdirSync(projectDir, { recursive: true });
  // Transcript entries per Claude session, each chained to the one before.
  const files = new Map<string, string[]>();
  const writeTranscript = (session: string) => {
    const uuids = files.get(session) ?? [];
    writeFileSync(
      join(projectDir, `${session}.jsonl`),
      uuids
        .map((uuid, i) => JSON.stringify({ type: "assistant", uuid, parentUuid: i > 0 ? uuids[i - 1] : null }))
        .join("\n") + "\n",
    );
  };
  const append = (session: string, ...uuids: string[]) => {
    files.set(session, [...(files.get(session) ?? []), ...uuids]);
    writeTranscript(session);
  };

  const { post, port, proxy } = await startMockedProxy("revert-edit");
  const { getForeignSessionId, getSessionTurns } = await import("../src/session-store.ts");

  // Forks copy the chain up to the leaf with fresh uuids.
  const forks: string[] = [];
  proxy.setClaudeSessionForker(async (id, at) => {
    const fork = `fork-${forks.length + 1}`;
    forks.push(`${id}@${at}`);
    const source = files.get(id) ?? [];
    append(fork, ...source.slice(0, source.indexOf(at) + 1).map((uuid) => `${fork}-${uuid}`));
    return fork;
  });

  let spawns = 0;
  let seen: StartClaudeQueryParams | null = null;
  // A turn that answers and moves the session's leaf to `leaf`.
  const answering = (leaf: string) =>
    proxy.setClaudeQueryStarter(async (params) => {
      spawns += 1;
      seen = params;
      const session = params.resume ?? `fresh-${spawns}`;
      append(session, leaf);
      return mockHandle(
        (async function* () {
          yield { type: "system", subtype: "init", session_id: session };
          yield { type: "assistant", uuid: leaf, session_id: session, parent_tool_use_id: null, message: { content: [] } };
          yield textDelta(`answer ${leaf}`);
          yield { type: "result", is_error: false, usage: {}, session_id: session };
        })(),
      );
    });
  const turn = async (leaf: string, messages: unknown[], extra: Record<string, unknown> = {}) => {
    answering(leaf);
    const forksBefore = forks.length;
    const res = await post("chat", { messages, ...extra });
    assert.equal(res.status, 200, `turn ${leaf}`);
    await res.text();
    assert.equal("resumeSessionAt" in seen!, false);
    return {
      resume: seen!.resume,
      fork: forks.length > forksBefore ? forks.at(-1) : undefined,
      transferred: /<conversation_history>/.test(await promptText(seen!.prompt)),
    };
  };
  const leaves = () => getSessionTurns("chat").map((t) => t.leafUuid);
  const where = () => getSessionTurns("chat").map((t) => `${t.sessionId}:${t.leafUuid}`);

  try {
    // Three turns build the session; each resumes it as is.
    let r = await turn("L1", [user("u1")]);
    assert.equal(r.resume, undefined);
    const first = getForeignSessionId("chat")!;
    r = await turn("L2", [user("u1"), assistant("a1"), user("u2")]);
    assert.deepEqual(r, { resume: first, fork: undefined, transferred: false });
    r = await turn("L3", [user("u1"), assistant("a1"), user("u2"), assistant("a2"), user("u3")]);
    assert.deepEqual(r, { resume: first, fork: undefined, transferred: false });
    assert.deepEqual(leaves(), ["L1", "L2", "L3"]);

    // Revert of the last turn, new prompt → a fork cut at L2. The undone
    // turn descends from L2, so a plain resume would bring it back.
    r = await turn("L3b", [user("u1"), assistant("a1"), user("u2"), assistant("a2"), user("u3 edited")]);
    assert.deepEqual(r, { resume: "fork-1", fork: `${first}@L2`, transferred: false });
    assert.equal(getForeignSessionId("chat"), "fork-1");
    // The current boundary moves to the fork's copy of L2; the older one
    // keeps pointing into the first session.
    assert.deepEqual(where(), [`${first}:L1`, "fork-1:fork-1-L2", "fork-1:L3b"]);

    // Normal follow-up after the rewind resumes the fork as is.
    const afterRewind = [user("u1"), assistant("a1"), user("u2"), assistant("a2"), user("u3 edited"), assistant("a3b")];
    r = await turn("L4", [...afterRewind, user("u4")]);
    assert.deepEqual(r, { resume: "fork-1", fork: undefined, transferred: false });

    // Back one turn inside the fork → fork of the fork, cut at L3b.
    r = await turn("L4b", [...afterRewind, user("u4 edited")]);
    assert.deepEqual(r, { resume: "fork-2", fork: "fork-1@L3b", transferred: false });
    assert.deepEqual(where(), [`${first}:L1`, "fork-1:fork-1-L2", "fork-2:fork-2-L3b", "fork-2:L4b"]);

    // Rewind across one fork: the boundary lives in fork-1, the chat in
    // fork-2. The new fork comes from fork-1.
    r = await turn("L3c", [user("u1"), assistant("a1"), user("u2"), assistant("a2"), user("u3 again")]);
    assert.deepEqual(r, { resume: "fork-3", fork: "fork-1@fork-1-L2", transferred: false });
    assert.deepEqual(where(), [`${first}:L1`, "fork-3:fork-3-fork-1-L2", "fork-3:L3c"]);

    // Rewind across two forks (fork-1, fork-3): back to the first session.
    r = await turn("L2d", [user("u1"), assistant("a1"), user("u2 again")]);
    assert.deepEqual(r, { resume: "fork-4", fork: `${first}@L1`, transferred: false });
    assert.deepEqual(where(), ["fork-4:fork-4-L1", "fork-4:L2d"]);

    // A retry right after a fork whose turn failed before Claude wrote
    // anything resumes that fork as is; nothing to cut.
    const d = [user("u1"), assistant("a1"), user("u2 again"), assistant("a2d")];
    r = await turn("L3d", [...d, user("u3")]);
    assert.deepEqual(r, { resume: "fork-4", fork: undefined, transferred: false });
    proxy.setClaudeQueryStarter(async (params) => {
      spawns += 1;
      seen = params;
      return mockHandle(
        (async function* () {
          yield { type: "result", subtype: "error_during_execution", is_error: true, errors: ["API Error: 500 boom"] };
        })(),
      );
    });
    await (await post("chat", { messages: [...d, user("u3 x")] })).text();
    assert.equal(seen!.resume, "fork-5");
    assert.equal(forks.at(-1), "fork-4@L2d");
    r = await turn("L3e", [...d, user("u3 x")]);
    assert.deepEqual(r, { resume: "fork-5", fork: undefined, transferred: false });

    // A rewind to a boundary whose session file is gone → history as text.
    assert.equal(where()[0], "fork-4:fork-4-L1");
    rmSync(join(projectDir, "fork-4.jsonl"));
    r = await turn("L2z", [user("u1"), assistant("a1"), user("u2 z")]);
    assert.deepEqual(r, { resume: undefined, fork: undefined, transferred: true });
    const fresh = getForeignSessionId("chat")!;

    // A model switch changes nothing.
    const base = [user("u1"), assistant("a1"), user("u2 z"), assistant("a2z")];
    r = await turn("L3m", [...base, user("u3")], { model: "opus" });
    assert.deepEqual(r, { resume: fresh, fork: undefined, transferred: false });

    // OpenCode retries the same request (the first attempt answered but the
    // response got lost): the retry goes back to where that attempt started.
    r = await turn("L3n", [...base, user("u3")]);
    assert.deepEqual(r, { resume: "fork-6", fork: `${fresh}@L2z`, transferred: false });

    // Plan mode reminder spliced before the prompt, stored after it later.
    const reminder = user("<system-reminder>\nYou are in Plan mode.\n</system-reminder>");
    const base2 = [...base, user("u3"), assistant("a3n")];
    r = await turn("L5c", [...base2, reminder, user("plan it")]);
    assert.deepEqual(r, { resume: "fork-6", fork: undefined, transferred: false });
    r = await turn("L6c", [...base2, user("plan it"), reminder, assistant("plan"), user("go")]);
    assert.deepEqual(r, { resume: "fork-6", fork: undefined, transferred: false });
    const planned = [...base2, user("plan it"), reminder, assistant("plan"), user("go"), assistant("done")];
    const session = getForeignSessionId("chat")!;

    // A title request leaves the boundaries alone.
    const before = JSON.stringify(getSessionTurns("chat"));
    answering("title-leaf");
    const title = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-opencode-claude-session": "chat",
        "x-opencode-claude-kind": "title",
      },
      body: JSON.stringify({ model: "sonnet", stream: false, messages: [user("u1")] }),
    });
    await title.text();
    assert.equal(JSON.stringify(getSessionTurns("chat")), before);

    // Tool-result continuation, steering and a later follow-up.
    proxy.setClaudeQueryStarter(async (params) => {
      spawns += 1;
      seen = params;
      append(session, "L7-tool");
      return mockHandle(
        (async function* () {
          yield { type: "system", subtype: "init", session_id: session };
          yield { type: "assistant", uuid: "L7-tool", session_id: session, parent_tool_use_id: null, message: { content: [] } };
          await callTool(params, "bash", { command: "ls" });
          yield { type: "user", uuid: "L7-result", session_id: session, parent_tool_use_id: null, message: { content: [] } };
          yield { type: "assistant", uuid: "L7", session_id: session, parent_tool_use_id: null, message: { content: [] } };
          yield textDelta("listed");
          yield { type: "result", is_error: false, usage: {}, session_id: session };
        })(),
      );
    });
    const askTool = [...planned, user("list files")];
    const forksBeforeTool = forks.length;
    const parked = await post("chat", { tools: [bashTool], messages: askTool });
    const call = ((await parked.json()) as any).choices[0].message.tool_calls[0];
    assert.equal(seen!.resume, session);
    assert.equal(forks.length, forksBeforeTool);
    const spawnsBefore = spawns;
    append(session, "L7-result", "L7");
    const toolStep = [
      ...askTool,
      { role: "assistant", content: null, tool_calls: [call] },
      { role: "tool", tool_call_id: call.id, content: "a.txt" },
      user("also count them"),
    ];
    const resumed = await post("chat", { tools: [bashTool], messages: toolStep });
    assert.equal(resumed.status, 200);
    await resumed.text();
    assert.equal(spawns, spawnsBefore, "continuation reuses the parked turn");
    assert.equal(getSessionTurns("chat").at(-1)!.leafUuid, "L7");
    r = await turn("L8", [...toolStep, assistant("2 files"), user("thanks")]);
    assert.deepEqual(r, { resume: session, fork: undefined, transferred: false });

    // Tool results with no parked turn (reaped): rebuilt, still resumed.
    // The turn that made the call started here, so the session saw its
    // prompt; nothing was missed.
    await turn("L9-start", [...toolStep, assistant("2 files"), user("thanks"), assistant("welcome"), user("run it")]);
    const orphanCall = { id: "call_orphan", type: "function", function: { name: "bash", arguments: "{}" } };
    const rebuiltHistory = [
      ...toolStep,
      assistant("2 files"),
      user("thanks"),
      assistant("welcome"),
      user("run it"),
      { role: "assistant", content: null, tool_calls: [orphanCall] },
      { role: "tool", tool_call_id: "call_orphan", content: "late" },
    ];
    r = await turn("L9", rebuiltHistory, { tools: [bashTool] });
    assert.deepEqual(r, { resume: session, fork: undefined, transferred: false });

    // A history that matches no turn: an early message changed.
    r = await turn("N1", [user("something else entirely"), assistant("a1"), user("u2")]);
    assert.equal(r.resume, undefined);
    assert.equal(r.transferred, true);
    assert.ok(getForeignSessionId("chat"), "the new turn binds again");
    assert.deepEqual(leaves(), ["N1"]);
  } finally {
    proxy.setClaudeQueryStarter(null);
    proxy.setClaudeSessionForker(null);
    await proxy.stopProxy();
  }
  console.log("ok — revert/edit regression passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
