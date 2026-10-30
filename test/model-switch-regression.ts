/**
 * The user switches a chat from Claude to another model and back. The
 * resumed Claude session never saw the other model's turns, so they reach
 * Claude with the new prompt — only those, not the turns the session holds —
 * and the turn after resumes plainly. Ported from upstream 1.3.7.
 */
import type { StartClaudeQueryParams } from "../src/query.ts";
import { assert, assistant, mockHandle, promptText, startMockedProxy, textDelta, user } from "./helpers.ts";

const SESSION = "sess-model-switch";

async function main() {
  const h = await startMockedProxy("model-switch");
  const store = await import("../src/session-store.ts");
  const calls: Array<{ resume?: string; prompt: string }> = [];
  let leaf = 0;
  h.proxy.setClaudeQueryStarter(async (params: StartClaudeQueryParams) => {
    calls.push({ resume: params.resume, prompt: await promptText(params.prompt) });
    const uuid = `leaf-${++leaf}`;
    h.append(SESSION, uuid);
    return mockHandle((async function* () {
      yield { type: "system", subtype: "init", session_id: SESSION };
      yield { type: "assistant", uuid, session_id: SESSION, parent_tool_use_id: null };
      yield textDelta("ok");
      yield { type: "result", is_error: false, usage: {}, session_id: SESSION };
    })());
  });
  const turn = async (messages: unknown[], key = "switch") => {
    const res = await h.post(key, { messages });
    assert.equal(res.status, 200, await res.clone().text());
    await res.text();
    return calls.at(-1)!;
  };

  try {
    const claudeTurns = [user("CLAUDE-ASK-ONE"), assistant("CLAUDE-ANSWER-ONE"), user("CLAUDE-ASK-TWO")];
    await turn(claudeTurns.slice(0, 1));
    const second = await turn(claudeTurns);
    assert.equal(second.resume, SESSION);
    assert.equal(second.prompt, "CLAUDE-ASK-TWO", "a plain follow-up carries no history");

    // Two turns answered by another model, then back to Claude.
    const otherModel = [
      ...claudeTurns,
      assistant("CLAUDE-ANSWER-TWO"),
      user("OTHER-ASK-ONE"),
      assistant("OTHER-ANSWER-ONE"),
      user("OTHER-ASK-TWO"),
      assistant("OTHER-ANSWER-TWO"),
      user("BACK-TO-CLAUDE"),
    ];
    const back = await turn(otherModel);
    assert.equal(back.resume, SESSION, "the Claude session still resumes");
    assert.deepEqual(h.forks, []);
    const [missed, request] = back.prompt.split("</conversation_history>");
    assert.match(missed!, /after your last turn/);
    assert.match(missed!, /OTHER-ASK-ONE[\s\S]*OTHER-ANSWER-ONE[\s\S]*OTHER-ASK-TWO[\s\S]*OTHER-ANSWER-TWO/,
      "the other model's turns reach Claude in order");
    assert.doesNotMatch(missed!, /CLAUDE-/, "turns the session holds are not repeated");
    assert.match(request!, /Latest user message:\nBACK-TO-CLAUDE$/);

    const next = await turn([...otherModel, assistant("CLAUDE-ANSWER-THREE"), user("NEXT")]);
    assert.equal(next.resume, SESSION);
    assert.equal(next.prompt, "NEXT", "the turn after carries no history again");

    // Claude's own answered tool step (no parked turn left): nothing missed,
    // so the step is relayed as Claude's own, with no history.
    const call = (id: string) => ({
      role: "assistant",
      content: "",
      tool_calls: [{ id, type: "function", function: { name: "read", arguments: "{}" } }],
    });
    const afterNext = [...otherModel, assistant("CLAUDE-ANSWER-THREE"), user("NEXT")];
    const own = await turn([...afterNext, call("call_own"), { role: "tool", tool_call_id: "call_own", content: "OWN-RESULT" }]);
    assert.equal(own.resume, SESSION);
    assert.match(own.prompt, /Your previous step called the tools below/);
    assert.match(own.prompt, /OWN-RESULT/);
    assert.doesNotMatch(own.prompt, /conversation_history/, "Claude's own step carries no history");

    // Another model's turns end in its answered tool step (ported from
    // upstream 14b0ea6): the turns before the step are handed over, and the
    // step is not called Claude's.
    const switchedStep = await turn([
      ...afterNext,
      assistant("CLAUDE-ANSWER-FOUR"),
      user("OTHER-ASK-THREE"),
      assistant("OTHER-ANSWER-THREE"),
      user("OTHER-ASK-FOUR"),
      call("call_other"),
      { role: "tool", tool_call_id: "call_other", content: "OTHER-RESULT" },
      user("KEEP-GOING"),
    ]);
    assert.equal(switchedStep.resume, SESSION);
    const [handover, step] = switchedStep.prompt.split("</conversation_history>");
    assert.match(handover!, /OTHER-ASK-THREE[\s\S]*OTHER-ANSWER-THREE[\s\S]*OTHER-ASK-FOUR/);
    assert.doesNotMatch(handover!, /CLAUDE-|OTHER-RESULT/, "seen turns and the step itself are not in the handover");
    assert.match(step!, /The model that handled the turns above called the tools below/);
    assert.doesNotMatch(step!, /Your previous step|rejected/);
    assert.match(step!, /OTHER-RESULT[\s\S]*KEEP-GOING/);

    // A legacy binding without turn boundaries can't tell where the missed
    // turns start: it still transfers the whole history.
    store.setForeignSessionId("legacy", SESSION, { history: store.historyFingerprint(claudeTurns.slice(0, 1)) });
    const legacy = await turn([...claudeTurns.slice(0, 1), assistant("x"), user("OTHER"), assistant("OTHER-ANSWER"), user("BACK")], "legacy");
    assert.equal(legacy.resume, undefined);
    assert.match(legacy.prompt, /could not be resumed[\s\S]*OTHER-ANSWER/);
  } finally {
    await h.cleanup();
  }
  console.log("ok — model switch regression passed");
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
