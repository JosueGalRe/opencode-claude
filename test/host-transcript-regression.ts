/**
 * Regression for #5: host-side history rewrites (context-pruning plugins,
 * transforms) must drop the Claude session binding so the turn rebuilds from
 * the host's array instead of resuming a stale transcript. OpenCode
 * compaction (summary meta request) must also clear the binding, and
 * OPENCODE_CLAUDE_HOST_TRANSCRIPT=0 restores resume-always behavior.
 *
 * Run: bun test/host-transcript-regression.ts
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROXY_TOKEN_HEADER } from "../src/constants.ts";

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), "opencode-claude-host-"));
  process.env.XDG_DATA_HOME = tmp;
  process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE = join(tmp, "rate-limit.json");
  // The resume path requires the Claude session file to exist on disk.
  const claudeConfig = join(tmp, "claude-config");
  mkdirSync(join(claudeConfig, "projects", "proj"), { recursive: true });
  writeFileSync(join(claudeConfig, "projects", "proj", "foreign-1.jsonl"), "");
  process.env.CLAUDE_CONFIG_DIR = claudeConfig;

  const {
    startProxy,
    stopProxy,
    setClaudeQueryStarter,
    getClaudeProxyBaseUrl,
    getProxyAuthToken,
  } = await import("../src/proxy.ts");
  const port = await startProxy();

  const seen: Array<{ resume?: string; prompt: string }> = [];
  setClaudeQueryStarter(async (params) => {
    let promptText = "";
    if (typeof params.prompt === "string") {
      promptText = params.prompt;
    } else if (params.prompt && Symbol.asyncIterator in params.prompt) {
      for await (const part of params.prompt as AsyncIterable<any>) {
        const content = part?.message?.content;
        promptText += typeof content === "string" ? content : JSON.stringify(content);
      }
    }
    seen.push({ resume: params.resume as string | undefined, prompt: promptText });
    return {
      stream: (async function* () {
        yield { type: "system", subtype: "init", session_id: "foreign-1" };
        yield {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "ok" },
          },
        };
        yield { type: "result", is_error: false, usage: {} };
      })(),
      close: () => {},
    };
  });

  const post = (session: string, messages: unknown[]) =>
    fetch(`${getClaudeProxyBaseUrl()}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [PROXY_TOKEN_HEADER]: getProxyAuthToken(),
        "x-opencode-claude-session": session,
      },
      body: JSON.stringify({ model: "sonnet", stream: false, messages }),
    }).then((r) => {
      assert.equal(r.status, 200);
      return r.json();
    });

  const user = (text: string) => ({ role: "user", content: text });
  const assistant = (text: string) => ({ role: "assistant", content: text });
  const summaryRequest = [
    {
      role: "system",
      content: "You are tasked with summarizing conversations for compaction.",
    },
    user("Please summarize what was done in this conversation."),
  ];

  try {
    // Turn 1 binds the Claude session.
    await post("conv-a", [user("one")]);
    // Turn 2 resumes it.
    await post("conv-a", [user("one"), assistant("a1"), user("two")]);
    assert.equal(seen.at(-1)!.resume, "foreign-1", "steady state resumes");

    // Turn 3 with an early message pruned: diverged history must not resume.
    await post("conv-a", [
      user("one"),
      user("two"),
      assistant("a2"),
      user("three"),
    ]);
    assert.equal(
      seen.at(-1)!.resume,
      undefined,
      "pruned host history drops the resume",
    );
    assert.match(
      seen.at(-1)!.prompt,
      /two/,
      "rebuilt transcript carries the host history",
    );

    // After the rebuild the new history binds again and resumes.
    await post("conv-a", [
      user("one"),
      user("two"),
      assistant("a2"),
      user("three"),
      assistant("a3"),
      user("four"),
    ]);
    assert.equal(seen.at(-1)!.resume, "foreign-1", "rebound session resumes");

    // Compaction: the summary meta request clears the binding, so the next
    // normal turn rebuilds from the compacted host array.
    await post("conv-a", summaryRequest);
    await post("conv-a", [user("summary as context"), user("five")]);
    assert.equal(
      seen.at(-1)!.resume,
      undefined,
      "post-compaction turn does not resume",
    );

    // Opt-out flag: diverged history resumes anyway.
    process.env.OPENCODE_CLAUDE_HOST_TRANSCRIPT = "0";
    await post("conv-b", [user("one")]);
    await post("conv-b", [user("one"), assistant("a1"), user("two")]);
    assert.equal(seen.at(-1)!.resume, "foreign-1");
    await post("conv-b", [user("two"), assistant("a2"), user("three")]);
    assert.equal(
      seen.at(-1)!.resume,
      "foreign-1",
      "flag off keeps resume-always behavior",
    );
  } finally {
    delete process.env.OPENCODE_CLAUDE_HOST_TRANSCRIPT;
    setClaudeQueryStarter(null);
    await stopProxy();
  }
  console.log("ok — host transcript regression passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
