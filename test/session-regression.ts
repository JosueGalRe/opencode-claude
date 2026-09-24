/**
 * Regression: Claude session reuse across turns.
 * - a second compaction still transfers the conversation (meta requests
 *   neither resume nor bind sessions);
 * - a V2 compaction (request-kind header) that lands mid-turn closes the
 *   parked turn and runs single-shot, whatever its wording;
 * - an OpenCode system-prompt change does not drop the session;
 * - sessions.json is written once per turn, not once per stream event;
 * - turns answered by another provider force a rebuild, while normal turns,
 *   steering and promoted tool media do not;
 * - tool results with no parked turn reach Claude instead of re-running the
 *   original instruction;
 * - promoted tool-result media rides the tool resolved in this request;
 * - an aborted non-streaming request closes the Claude turn.
 *
 * Run: bun test/session-regression.ts
 */
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaudeQueryHandle, StartClaudeQueryParams } from "../src/query.ts";

const SESSION_ID = "sess-regression";

type McpBlock = { type: string; text?: string; data?: string };
type McpHandlers = Map<
  string,
  (request: unknown, extra: unknown) => Promise<{ content: McpBlock[] }>
>;
type McpServer = {
  instance: { server?: { _requestHandlers: McpHandlers }; _requestHandlers?: McpHandlers };
};
type Completion = {
  choices: Array<{
    message: {
      content: string;
      tool_calls: Array<{ id: string; function: { name: string; arguments: string } }>;
    };
  }>;
};
type Call = { resume?: string; prompt: string; maxTurns?: number };
type Script = (
  params: StartClaudeQueryParams,
  closed: Promise<void>,
) => AsyncGenerator<unknown, void, unknown>;

async function promptText(prompt: StartClaudeQueryParams["prompt"]): Promise<string> {
  if (typeof prompt === "string") return prompt;
  let text = "";
  for await (const part of prompt) {
    const content = (part as { message?: { content?: unknown } }).message?.content;
    text += typeof content === "string" ? content : JSON.stringify(content);
  }
  return text;
}

const textDelta = (text: string) => ({
  type: "stream_event",
  session_id: SESSION_ID,
  event: { type: "content_block_delta", delta: { type: "text_delta", text } },
});

const textTurn: Script = async function* () {
  yield { type: "system", subtype: "init", session_id: SESSION_ID };
  yield textDelta("ok");
  yield { type: "result", is_error: false, usage: {}, session_id: SESSION_ID };
};

/** Calls each tool in turn (one park per call), then answers DONE. */
function toolTurn(
  calls: Array<{ name: string; args: Record<string, unknown> }>,
  received: McpBlock[][],
): Script {
  return async function* (params) {
    const server = (params.mcpServers as Record<string, McpServer>).opencode;
    const handlers = (server.instance.server?._requestHandlers ??
      server.instance._requestHandlers)!;
    yield { type: "system", subtype: "init", session_id: SESSION_ID };
    for (const call of calls) {
      const res = await handlers.get("tools/call")!(
        { method: "tools/call", params: { name: call.name, arguments: call.args } },
        {},
      );
      received.push(res.content);
      yield { type: "user", message: { role: "user", content: [] }, session_id: SESSION_ID };
    }
    yield textDelta("DONE");
    yield { type: "result", is_error: false, usage: {}, session_id: SESSION_ID };
  };
}

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), "opencode-claude-session-"));
  process.env.XDG_DATA_HOME = tmp;
  process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE = join(tmp, "rate-limit.json");
  // Resume requires the Claude transcript on disk.
  const claudeConfig = join(tmp, "claude-config");
  mkdirSync(join(claudeConfig, "projects", "proj"), { recursive: true });
  writeFileSync(join(claudeConfig, "projects", "proj", `${SESSION_ID}.jsonl`), "");
  process.env.CLAUDE_CONFIG_DIR = claudeConfig;
  const storeFile = join(tmp, "opencode-claude", "sessions.json");

  // Dynamic: the env above must be set before the proxy modules load.
  const { startProxy, stopProxy, setClaudeQueryStarter, getProxyAuthToken } =
    await import("../src/proxy.ts");
  const port = await startProxy();

  const calls: Call[] = [];
  let script: Script = textTurn;
  let closeCount = 0;
  setClaudeQueryStarter(async (params) => {
    calls.push({
      resume: params.resume,
      prompt: await promptText(params.prompt),
      maxTurns: params.maxTurns,
    });
    const closed = Promise.withResolvers<void>();
    const handle: ClaudeQueryHandle = {
      stream: script(params, closed.promise),
      close: () => {
        closeCount++;
        closed.resolve();
      },
    };
    return handle;
  });

  const post = (
    session: string,
    messages: unknown[],
    extra: Record<string, unknown> = {},
    signal?: AbortSignal,
    headers: Record<string, string> = {},
  ) =>
    fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${getProxyAuthToken()}`,
        "x-opencode-claude-session": session,
        ...headers,
      },
      body: JSON.stringify({ model: "sonnet", stream: false, messages, ...extra }),
      signal,
    });
  const turn = async (session: string, messages: unknown[], extra = {}) => {
    const res = await post(session, messages, extra);
    assert.equal(res.status, 200, await res.clone().text());
    return (await res.json()) as Completion;
  };

  const user = (content: unknown) => ({ role: "user", content });
  const assistant = (content: string) => ({ role: "assistant", content });
  const toolCall = (id: string, name: string, args: string) => ({
    role: "assistant",
    content: null,
    tool_calls: [{ id, type: "function", function: { name, arguments: args } }],
  });
  const toolResult = (id: string, content: string) => ({
    role: "tool",
    tool_call_id: id,
    content,
  });
  const promotedImage = (data: string) =>
    user([
      { type: "text", text: "Attached media from tool result:" },
      { type: "image_url", image_url: { url: `data:image/png;base64,${data}` } },
    ]);
  const tool = (name: string) => ({
    type: "function",
    function: {
      name,
      description: name,
      parameters: { type: "object", properties: { path: { type: "string" } } },
    },
  });

  try {
    // --- Second compaction still transfers the conversation. ---
    await turn("compact", [user("one")]);
    const summarySystem = {
      role: "system",
      content: "You are tasked with summarizing conversations for compaction.",
    };
    const summaryAsk = user("Create a detailed summary for continuing this coding session.");
    await turn("compact", [summarySystem, user("one"), assistant("alpha-answer"), summaryAsk]);
    assert.equal(calls.at(-1)!.resume, undefined);
    assert.match(calls.at(-1)!.prompt, /alpha-answer/);
    await turn("compact", [
      summarySystem,
      user("one"),
      assistant("alpha-answer"),
      user("two"),
      assistant("beta-answer"),
      summaryAsk,
    ]);
    assert.equal(calls.at(-1)!.resume, undefined);
    assert.match(calls.at(-1)!.prompt, /beta-answer/, "second compaction sees the history");
    const stored = JSON.parse(readFileSync(storeFile, "utf8")) as Record<string, unknown>;
    assert.ok(
      !Object.keys(stored).some((key) => key.startsWith("summary:")),
      "meta requests bind no Claude session",
    );

    // --- A V2 compaction mid-turn is a summary whatever its wording: the
    // parked turn is closed, not answered with its re-emitted tool call. ---
    let parkedClosed = false;
    script = async function* (params, closed) {
      void closed.then(() => (parkedClosed = true));
      yield* toolTurn([{ name: "bash", args: { path: "x" } }], [])(params, closed);
    };
    const parked = await turn("v2-compact", [user("run it")], { tools: [tool("bash")] });
    const parkedCall = parked.choices[0].message.tool_calls[0];
    script = textTurn;
    const compactRes = await post(
      "v2-compact",
      [
        user("run it"),
        toolCall(parkedCall.id, "bash", parkedCall.function.arguments),
        user("You MUST summarize the conversation above."),
      ],
      {},
      undefined,
      { "x-opencode-claude-request-kind": "compaction" },
    );
    assert.equal(compactRes.status, 200, await compactRes.clone().text());
    const compacted = (await compactRes.json()) as Completion;
    assert.equal(compacted.choices[0].message.content, "ok", "summary, not the parked tool call");
    assert.equal(calls.at(-1)!.maxTurns, 1, "single-shot meta request");
    assert.ok(parkedClosed, "parked turn closed");

    // --- System prompt changes (model/agent/date) keep the session. ---
    await turn("sys", [{ role: "system", content: "Model: sonnet" }, user("one")]);
    await turn("sys", [
      { role: "system", content: "Model: opus. Today is tomorrow." },
      user("one"),
      assistant("a1"),
      user("two"),
    ]);
    assert.equal(calls.at(-1)!.resume, SESSION_ID, "system prompt change keeps resume");

    // --- sessions.json is written once per turn, not per stream event. ---
    const inodes: number[] = [];
    script = async function* () {
      const observe = () => inodes.push(statSync(storeFile).ino);
      observe();
      yield { type: "system", subtype: "init", session_id: SESSION_ID };
      for (let i = 0; i < 20; i++) {
        observe();
        yield textDelta(`t${i}`);
      }
      observe();
      yield { type: "result", is_error: false, usage: {}, session_id: SESSION_ID };
      observe();
    };
    await turn("writes", [user("count writes")]);
    const writes = inodes.filter((ino, i) => i > 0 && ino !== inodes[i - 1]).length;
    assert.equal(writes, 1, `store rewritten ${writes} times in one turn`);
    script = textTurn;

    // --- Turns answered by another provider force a rebuild. ---
    await turn("foreign", [user("u1")]);
    await turn("foreign", [user("u1"), assistant("a1"), user("u2")]);
    assert.equal(calls.at(-1)!.resume, SESSION_ID, "normal next turn resumes");
    await turn("foreign", [
      user("u1"),
      assistant("a1"),
      user("u2"),
      assistant("a2"),
      user("u3"),
      assistant("other-provider-answer"),
      user("u4"),
    ]);
    assert.equal(calls.at(-1)!.resume, undefined, "foreign turn drops resume");
    assert.match(calls.at(-1)!.prompt, /other-provider-answer/);
    await turn("foreign", [
      user("u1"),
      assistant("a1"),
      user("u2"),
      assistant("a2"),
      user("u3"),
      assistant("other-provider-answer"),
      user("u4"),
      assistant("a4"),
      user("u5"),
    ]);
    assert.equal(calls.at(-1)!.resume, SESSION_ID, "rebound session resumes");

    // --- Steering does not read as a foreign turn. ---
    const steerReceived: McpBlock[][] = [];
    script = toolTurn([{ name: "bash", args: { path: "x" } }], steerReceived);
    const s1 = await turn("steer", [user("run it")], { tools: [tool("bash")] });
    const steerCall = s1.choices[0].message.tool_calls[0];
    const steerHistory = [
      user("run it"),
      toolCall(steerCall.id, "bash", steerCall.function.arguments),
      toolResult(steerCall.id, "exit 0"),
      user("Also use PINEAPPLE."),
    ];
    const s2 = await turn("steer", steerHistory, { tools: [tool("bash")] });
    assert.match(s2.choices[0].message.content, /DONE/);
    assert.match(JSON.stringify(steerReceived[0]), /PINEAPPLE/);
    script = textTurn;
    await turn("steer", [...steerHistory, assistant("DONE"), user("next")]);
    assert.equal(calls.at(-1)!.resume, SESSION_ID, "steering keeps resume");

    // --- Promoted media maps to the tool resolved in this request. ---
    const mediaReceived: McpBlock[][] = [];
    script = toolTurn(
      [
        { name: "read", args: { path: "a.png" } },
        { name: "read", args: { path: "b.png" } },
      ],
      mediaReceived,
    );
    const readTool = { tools: [tool("read")] };
    const m1 = await turn("media", [user("look at both")], readTool);
    const c1 = m1.choices[0].message.tool_calls[0];
    const step1 = [
      user("look at both"),
      toolCall(c1.id, "read", c1.function.arguments),
      toolResult(c1.id, "text A"),
      promotedImage("SU1HQQ=="),
    ];
    const m2 = await turn("media", step1, readTool);
    const c2 = m2.choices[0].message.tool_calls[0];
    const step2 = [
      ...step1,
      toolCall(c2.id, "read", c2.function.arguments),
      toolResult(c2.id, "text B"),
      promotedImage("SU1HQg=="),
    ];
    const m3 = await turn("media", step2, readTool);
    assert.match(m3.choices[0].message.content, /DONE/);
    const images = (content: McpBlock[]) =>
      content.filter((b) => b.type === "image").map((b) => b.data);
    assert.deepEqual(images(mediaReceived[0]), ["SU1HQQ=="]);
    assert.deepEqual(
      images(mediaReceived[1]),
      ["SU1HQg=="],
      "second read gets its own image, not the first step's",
    );
    script = textTurn;
    await turn("media", [...step2, assistant("DONE"), user("thanks")]);
    assert.equal(calls.at(-1)!.resume, SESSION_ID, "tool round trips keep resume");

    // --- Tool results with no parked turn reach Claude. ---
    await turn("orphan", [user("hello")]);
    const orphanCalls = calls.length;
    await turn("orphan", [
      user("hello"),
      assistant("hi"),
      user("list the files"),
      toolCall("call_gone", "bash", '{"command":"ls"}'),
      toolResult("call_gone", "file-A\nfile-B"),
    ]);
    assert.equal(calls.length, orphanCalls + 1);
    const orphan = calls.at(-1)!;
    assert.equal(orphan.resume, undefined, "orphaned results rebuild the turn");
    assert.match(orphan.prompt, /list the files/, "history before the step");
    assert.match(orphan.prompt, /file-A\\nfile-B/, "tool result reaches Claude");
    assert.match(orphan.prompt, /\\"command\\":\\"ls\\"/, "tool call reaches Claude");
    assert.match(orphan.prompt, /Continue the task from these results/);

    // --- Old bindings age out; an unreadable store is kept aside, not wiped. ---
    const aged = JSON.parse(readFileSync(storeFile, "utf8")) as Record<string, unknown>;
    aged.ancient = {
      conversationKey: "ancient",
      foreignSessionId: "gone",
      updatedAt: Date.now() - 40 * 24 * 60 * 60 * 1000,
    };
    writeFileSync(storeFile, JSON.stringify(aged));
    await turn("maintain", [user("m1")]);
    const pruned = JSON.parse(readFileSync(storeFile, "utf8")) as Record<string, unknown>;
    assert.ok(!("ancient" in pruned), "40-day-old binding evicted");
    assert.ok("foreign" in pruned && "maintain" in pruned, "fresh bindings kept");
    writeFileSync(storeFile, '{"foreign": {"conversationKey"');
    await turn("maintain-2", [user("m2")]);
    const storeDir = join(tmp, "opencode-claude");
    const backups = readdirSync(storeDir).filter((name) =>
      name.startsWith("sessions.json.corrupt-"),
    );
    assert.equal(backups.length, 1, "unreadable store moved aside");
    assert.match(readFileSync(join(storeDir, backups[0]!), "utf8"), /"foreign"/);
    const rebuilt = JSON.parse(readFileSync(storeFile, "utf8")) as Record<string, unknown>;
    assert.ok("maintain-2" in rebuilt);
    assert.ok(
      !readdirSync(storeDir).some((name) => name.endsWith(".tmp")),
      "no temp files left behind",
    );

    // --- Aborted non-streaming request closes the turn. ---
    script = async function* (_params, closed) {
      yield { type: "system", subtype: "init", session_id: SESSION_ID };
      await closed;
    };
    const before = closeCount;
    const controller = new AbortController();
    const pending = post("abort", [user("slow")], {}, controller.signal).catch(() => null);
    await new Promise((resolve) => setTimeout(resolve, 200));
    controller.abort();
    await pending;
    for (let i = 0; i < 40 && closeCount === before; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(closeCount > before, "client abort closes the Claude turn");
  } finally {
    setClaudeQueryStarter(null);
    await stopProxy();
  }
  console.log("ok — session regression passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
