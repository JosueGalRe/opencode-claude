/**
 * Regression: the user switches a chat from Claude to another model and
 * back. The resumed Claude session never saw the other model's turns, so
 * they must reach Claude with the new prompt — only those, not the turns
 * the session already holds — and the turn after must resume plainly.
 *
 * Run: bun test/model-switch-regression.ts
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StartClaudeQueryParams } from "../src/query.ts";
import { assert, mockHandle, startMockedProxy, textDelta } from "./helpers.ts";

const SESSION_ID = "sess-model-switch";

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
  // Resume requires the Claude transcript on disk.
  const claudeConfig = mkdtempSync(join(tmpdir(), "opencode-claude-switch-cfg-"));
  mkdirSync(join(claudeConfig, "projects", "proj"), { recursive: true });
  writeFileSync(join(claudeConfig, "projects", "proj", `${SESSION_ID}.jsonl`), "");
  process.env.CLAUDE_CONFIG_DIR = claudeConfig;

  const user = (content: string) => ({ role: "user", content });
  const assistant = (content: string) => ({ role: "assistant", content });

  const { post, proxy } = await startMockedProxy("model-switch");

  const calls: Array<{ resume?: string; prompt: string }> = [];
  proxy.setClaudeQueryStarter(async (params) => {
    calls.push({ resume: params.resume, prompt: await promptText(params.prompt) });
    return mockHandle(
      (async function* () {
        yield { type: "system", subtype: "init", session_id: SESSION_ID };
        yield { ...textDelta("ok"), session_id: SESSION_ID };
        yield { type: "result", is_error: false, usage: {}, session_id: SESSION_ID };
      })(),
    );
  });

  const turn = async (messages: unknown[]) => {
    const res = await post("switch", { messages });
    assert.equal(res.status, 200, await res.clone().text());
    return calls.at(-1)!;
  };

  try {
    const claudeTurns = [
      user("CLAUDE-ASK-ONE"),
      assistant("CLAUDE-ANSWER-ONE"),
      user("CLAUDE-ASK-TWO"),
    ];
    await turn(claudeTurns.slice(0, 1));
    const second = await turn(claudeTurns);
    assert.equal(second.resume, SESSION_ID);
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
    assert.equal(back.resume, SESSION_ID, "the Claude session still resumes");
    const [missed, request] = back.prompt.split("</conversation_history>");
    assert.match(missed!, /after your last turn/);
    assert.match(
      missed!,
      /OTHER-ASK-ONE[\s\S]*OTHER-ANSWER-ONE[\s\S]*OTHER-ASK-TWO[\s\S]*OTHER-ANSWER-TWO/,
      "the other model's turns reach Claude in order",
    );
    assert.doesNotMatch(missed!, /CLAUDE-/, "turns the session holds are not repeated");
    assert.match(request!, /Latest user message:\nBACK-TO-CLAUDE$/);

    const next = await turn([...otherModel, assistant("CLAUDE-ANSWER-THREE"), user("NEXT")]);
    assert.equal(next.resume, SESSION_ID);
    assert.equal(next.prompt, "NEXT", "the turn after carries no history again");
  } finally {
    proxy.setClaudeQueryStarter(null);
    await proxy.stopProxy();
  }
  console.log("ok — model switch regression passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
