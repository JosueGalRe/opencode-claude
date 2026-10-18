/**
 * Regression: OpenChamber attaches session context (its guidance, pinned
 * notes, memory, checkout) through OpenCode's session instructions API.
 * OpenCode renders the values as `<context key="…">` blocks in its system
 * prompt, and the proxy dropped them with the rest of that prompt (Claude
 * Code's preset replaces it). So Claude never read OpenChamber's instruction
 * to link issues and PRs to the session. Later changes arrive as
 * `<system-update>` user text and already reached Claude.
 *
 * Run: bun test/session-context-regression.ts
 */
import { assert, startMockedProxy, textDelta } from "./helpers.ts";
import { withSteering } from "../src/prompt.ts";

const GUIDANCE =
  '<context key="openchamber.guidance">\nLink to this session with the openchamber tool\'s session.link each pull request you open.\n</context>';
const CHANGED =
  'The context under "openchamber.pinned" changed and supersedes the previous value:\n<context key="openchamber.pinned">\nShip on Friday.\n</context>';

function promptText(prompt: unknown): string {
  if (typeof prompt === "string") return prompt;
  return JSON.stringify(prompt);
}

async function main() {
  const keepAlive = setInterval(() => {}, 1000);
  const { post, proxy } = await startMockedProxy("session-context");
  const seen: Array<{ append: string; prompt: string }> = [];
  try {
    proxy.setClaudeQueryStarter(async (params: any) => {
      let prompt = params.prompt;
      if (prompt && typeof prompt === "object" && Symbol.asyncIterator in prompt) {
        for await (const m of prompt) {
          prompt = m;
          break;
        }
      }
      seen.push({ append: params.systemPrompt?.append ?? "", prompt: promptText(prompt) });
      const turn = seen.length;
      return {
        stream: (async function* () {
          yield { type: "system", subtype: "init", session_id: `ctx-${turn}` };
          yield textDelta(`answer ${turn}`);
          yield { type: "result", is_error: false, usage: {}, session_id: `ctx-${turn}` };
        })(),
        interrupt: async () => {},
        close: () => {},
        getPid: () => null,
      };
    });

    const system = { role: "system", content: `You are OpenCode.\n\n${GUIDANCE}` };
    const first = [system, { role: "user", content: "fix the bug" }];
    await (await post("ctx", { messages: first })).json();
    assert.ok(seen[0]!.append.includes(GUIDANCE), "context entries reach Claude's system prompt");
    assert.ok(!seen[0]!.append.includes("You are OpenCode"), "the rest of OpenCode's prompt stays out");

    // A pinned note changed before the next message: OpenCode sends it as user text.
    const second = [
      ...first,
      { role: "assistant", content: "answer 1" },
      { role: "user", content: `<system-update>\n${CHANGED}\n</system-update>` },
      { role: "user", content: "and now?" },
    ];
    await (await post("ctx", { messages: second })).json();
    assert.ok(seen[1]!.prompt.includes("Ship on Friday."), "a changed entry reaches the next prompt");
    assert.ok(seen[1]!.prompt.includes("and now?"));
    assert.equal(seen[1]!.append, seen[0]!.append, "the system prompt stays the same, so the cache holds");
    // The same update while a tool ran is not passed off as the user's message.
    const update = `<system-update>\n${CHANGED}\n</system-update>`;
    const result = [{ type: "text" as const, text: "a.txt" }];
    const onlyUpdate = withSteering(result, [{ type: "text", text: update }]);
    assert.deepEqual(onlyUpdate.map((b: any) => b.text), ["a.txt", update]);
    const both = withSteering(result, [{ type: "text", text: update }, { type: "text", text: "stop" }]);
    assert.equal(both.length, 3);
    assert.ok(!(both[1] as any).text.includes("the user sent"));
    assert.ok((both[2] as any).text.includes("the user sent") && (both[2] as any).text.includes("stop"));
    assert.ok(!(both[2] as any).text.includes("Ship on Friday."));
    console.log("session-context regression ok");
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
