/** Offline proxy harness: no Claude process, isolated store and transcripts. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROXY_TOKEN_HEADER, SESSION_HEADER } from "../src/constants.ts";
import type { ClaudeQueryHandle, StartClaudeQueryParams } from "../src/query.ts";

export async function startMockedProxy(label: string) {
  const tmp = mkdtempSync(join(tmpdir(), `opencode-claude-${label}-`));
  process.env.XDG_DATA_HOME = tmp;
  process.env.CLAUDE_CONFIG_DIR = join(tmp, "claude");
  process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE = join(tmp, "rate-limit.json");
  process.env.OPENCODE_CLAUDE_STOP_GRACE_MS ??= "50";
  const { setAuthStatusProbe } = await import("../src/detect.ts");
  setAuthStatusProbe(async () => ({ detail: "auth-status-oauth" }));
  const proxy = await import("../src/proxy.ts");
  await proxy.startProxy();
  const post = (session: string, body: Record<string, unknown>, headers = {}) =>
    fetch(`${proxy.getClaudeProxyBaseUrl()}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [PROXY_TOKEN_HEADER]: proxy.getProxyAuthToken(),
        [SESSION_HEADER]: session,
        ...headers,
      },
      body: JSON.stringify({ model: "sonnet", stream: false, ...body }),
    });
  // Main-chain entries as the CLI writes them, each a child of the one before.
  const transcript = (session: string, leaves: string[]) => {
    const dir = join(tmp, "claude", "projects", "original-project");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${session}.jsonl`);
    writeFileSync(file, leaves.map((uuid, i) =>
      JSON.stringify({ type: "assistant", uuid, parentUuid: leaves[i - 1] ?? null })).join("\n") + "\n");
    return file;
  };
  // Forks copy the chain up to the cut with fresh uuids (`<fork>-<uuid>`).
  const forks: string[] = [];
  const chains = new Map<string, string[]>();
  const forker = async (id: string, at: string) => {
    const fork = `fork-${forks.length + 1}`;
    forks.push(`${id}@${at}`);
    const source = chains.get(id) ?? [];
    chains.set(fork, source.slice(0, source.indexOf(at) + 1).map((uuid) => `${fork}-${uuid}`));
    transcript(fork, chains.get(fork)!);
    return fork;
  };
  /** Append to a session's chain, keeping the forker's copy source in sync. */
  const append = (session: string, ...uuids: string[]) => {
    chains.set(session, [...(chains.get(session) ?? []), ...uuids]);
    return transcript(session, chains.get(session)!);
  };
  proxy.setClaudeSessionForker(forker);
  const cleanup = async () => {
    proxy.setClaudeQueryStarter(null);
    proxy.setClaudeSessionForker(null);
    await proxy.stopProxy();
    setAuthStatusProbe(null);
    rmSync(tmp, { recursive: true, force: true });
  };
  return { tmp, post, proxy, transcript, append, forks, cleanup };
}

export const user = (content: unknown) => ({ role: "user", content });
export const assistant = (content: string) => ({ role: "assistant", content });
export const textDelta = (text: string) => ({
  type: "stream_event",
  event: { type: "content_block_delta", delta: { type: "text_delta", text } },
});
export const result = { type: "result", is_error: false, usage: {} };
export const bashTool = {
  type: "function",
  function: {
    name: "bash", description: "Run a command",
    parameters: { type: "object", properties: { command: { type: "string" } } },
  },
};

export function mockHandle(stream: AsyncIterable<unknown>): ClaudeQueryHandle {
  return { stream, close() {} };
}

export async function promptText(prompt: StartClaudeQueryParams["prompt"]): Promise<string> {
  if (typeof prompt === "string") return prompt;
  const parts: unknown[] = [];
  for await (const part of prompt) parts.push(part);
  return JSON.stringify(parts);
}

/** Call the real MCP adapter at its transport boundary, not the real CLI. */
export async function callTool(params: StartClaudeQueryParams) {
  const mcp = params.mcpServers?.opencode;
  assert.ok(mcp && typeof mcp === "object" && "instance" in mcp);
  const instance = mcp.instance;
  assert.ok(instance && typeof instance === "object" && "server" in instance);
  const server = instance.server;
  assert.ok(server && typeof server === "object" && "_requestHandlers" in server);
  assert.ok(server._requestHandlers instanceof Map);
  const handler: unknown = server._requestHandlers.get("tools/call");
  assert.equal(typeof handler, "function");
  if (typeof handler !== "function") throw new Error("Missing MCP handler");
  return handler(
    { method: "tools/call", params: { name: "bash", arguments: { command: "ls" } } },
    { signal: new AbortController().signal },
  );
}

/** Mimics the CLI's main-chain entries emitted after an SDK interrupt. */
export function interruptibleTurn(input: {
  log: string[];
  name: string;
  body: () => AsyncGenerator<unknown>;
  sessionId?: string;
  settle?: Promise<void>;
}) {
  const interrupted = Promise.withResolvers<"interrupt">();
  const closed = Promise.withResolvers<void>();
  return {
    stream: (async function* () {
      const inner = input.body();
      while (true) {
        const next = await Promise.race([inner.next(), interrupted.promise]);
        if (next === "interrupt") break;
        if (next.done) return;
        yield next.value;
      }
      await input.settle;
      for (const suffix of ["reject", "marker"]) {
        yield {
          type: "user", uuid: `${input.name}-${suffix}`, session_id: input.sessionId,
          parent_tool_use_id: null, message: { content: [] },
        };
      }
      yield { ...result, session_id: input.sessionId, terminal_reason: "aborted_tools" };
    })(),
    interrupt: async () => {
      input.log.push(`${input.name}:interrupt`);
      interrupted.resolve("interrupt");
    },
    close: () => {
      input.log.push(`${input.name}:close`);
      closed.resolve();
    },
    interrupted: interrupted.promise,
    closed: closed.promise,
  };
}

export { assert };
