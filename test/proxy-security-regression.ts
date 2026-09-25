/**
 * Regression: the local proxy is reachable by every local process and by
 * browser pages, so POST /v1/chat/completions must require the plugin's
 * token, refuse browser origins and non-plan CLI logins, never run Claude
 * Code's native tools with auto-approval, map errors to truthful statuses,
 * close parked CLI turns on
 * shutdown, and take over a pinned port when the sibling serving it exits.
 *
 * Run: bun test/proxy-security-regression.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

async function freePort(): Promise<number> {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  return port;
}

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), "opencode-claude-security-"));
  const port = await freePort();
  const env = {
    ...process.env,
    XDG_DATA_HOME: tmp,
    OPENCODE_CLAUDE_RATE_LIMIT_STORE: join(tmp, "rate-limit.json"),
    OPENCODE_CLAUDE_PROXY_PORT: String(port),
  };
  Object.assign(process.env, env);

  // A sibling OpenCode process owns the pinned port first.
  const proxyModule = resolve(import.meta.dir, "../src/proxy.ts");
  const sibling = Bun.spawn(
    [
      process.execPath,
      "-e",
      `const { startProxy } = await import(${JSON.stringify(proxyModule)});
       await startProxy();
       console.log("sibling-ready");
       setInterval(() => {}, 1000);`,
    ],
    { env, stdout: "pipe", stderr: "inherit" },
  );
  const reader = sibling.stdout.getReader();
  let out = "";
  while (!out.includes("sibling-ready")) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`sibling proxy exited early: ${out}`);
    out += new TextDecoder().decode(value);
  }

  const {
    startProxy,
    stopProxy,
    setClaudeQueryStarter,
    getProxyAuthToken,
    getProxyPort,
  } = await import("../src/proxy.ts");
  const { setAuthStatusProbe } = await import("../src/detect.ts");
  const { PROXY_TOKEN_HEADER } = await import("../src/constants.ts");
  const url = `http://127.0.0.1:${port}/v1/chat/completions`;

  try {
    // Pinned mode: one 0600 token file shared by every process on the port.
    assert.equal(await startProxy(), port);
    const tokenFile = join(tmp, "opencode-claude", "proxy-token");
    assert.equal(readFileSync(tokenFile, "utf8").trim(), getProxyAuthToken());
    assert.equal(statSync(tokenFile).mode & 0o777, 0o600);

    // The sibling accepts our token: malformed JSON reaches the parser (400)
    // instead of being refused (401).
    const viaSibling = await fetch(url, {
      method: "POST",
      headers: { [PROXY_TOKEN_HEADER]: getProxyAuthToken() },
      body: "{not json",
    });
    assert.equal(viaSibling.status, 400);

    // Sibling exits: this process takes over the pinned port.
    sibling.kill();
    await sibling.exited;
    const deadline = Date.now() + 15_000;
    let tookOver = false;
    while (Date.now() < deadline) {
      await Bun.sleep(250);
      const health = await fetch(`http://127.0.0.1:${port}/health`).catch(() => null);
      if (health?.ok) {
        tookOver = true;
        break;
      }
    }
    assert.ok(tookOver, "pinned port taken over after the sibling exited");

    let calls = 0;
    let seen: Record<string, any> | null = null;
    setClaudeQueryStarter(async (params) => {
      calls += 1;
      seen = params as unknown as Record<string, any>;
      return {
        stream: (async function* () {
          yield { type: "system", subtype: "init", session_id: "security-sess" };
          yield { type: "result", is_error: false, usage: {} };
        })(),
        close: () => {},
      };
    });

    const chat = { model: "sonnet", stream: false, messages: [{ role: "user", content: "hi" }] };
    const post = (headers: Record<string, string>, body: unknown = chat) =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
      });

    // Unauthenticated / wrong token / browser origin never start a turn.
    const missing = await post({});
    assert.equal(missing.status, 401);
    assert.equal(
      ((await missing.json()) as { error: { type: string } }).error.type,
      "authentication_error",
    );
    assert.equal((await post({ authorization: "Bearer nope" })).status, 401);
    assert.equal((await post({ [PROXY_TOKEN_HEADER]: "nope" })).status, 401);
    const browser = await post({
      [PROXY_TOKEN_HEADER]: getProxyAuthToken(),
      origin: "https://evil.example",
    });
    assert.equal(browser.status, 403);
    assert.equal(calls, 0, "rejected requests must not start Claude Code");

    // Read-only routes stay open for UIs and sibling health checks.
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/models`)).status, 200);

    // Header token and Bearer token both work; a stale Bearer (V2 connection
    // marker) does not block a valid header.
    assert.equal((await post({ [PROXY_TOKEN_HEADER]: getProxyAuthToken() })).status, 200);
    assert.equal(
      (await post({ authorization: `Bearer ${getProxyAuthToken()}` })).status,
      200,
    );
    assert.equal(
      (
        await post({
          authorization: "Bearer managed-by-claude-code-cli",
          [PROXY_TOKEN_HEADER]: getProxyAuthToken(),
        })
      ).status,
      200,
    );

    // A tool-less agent turn gets no native tools and no auto-approval.
    assert.deepEqual(seen!.tools, []);
    assert.equal(seen!.permissionMode, "dontAsk");
    assert.equal(seen!.canUseTool, undefined);
    assert.ok(!seen!.allowDangerouslySkipPermissions);
    assert.equal(seen!.allowedTools, undefined);

    const auth = { [PROXY_TOKEN_HEADER]: getProxyAuthToken() };

    // Malformed JSON is a client error.
    const malformed = await post(auth, "{not json");
    assert.equal(malformed.status, 400);
    assert.equal(
      ((await malformed.json()) as { error: { type: string } }).error.type,
      "invalid_request_error",
    );

    // A CLI signed in with an API key or a cloud provider is refused before
    // any turn starts: this provider serves Claude plans only.
    calls = 0;
    setAuthStatusProbe(async () => ({ detail: "api-key-only" }));
    const apiKeyLogin = await post(auth);
    assert.equal(apiKeyLogin.status, 401);
    assert.match(
      ((await apiKeyLogin.json()) as { error: { message: string } }).error.message,
      /API key/,
    );
    assert.equal(calls, 0);
    setAuthStatusProbe(null);

    // Errors carrying a statusCode keep it (e.g. CLAUDE_SDK_UNAVAILABLE).
    setClaudeQueryStarter(async () => {
      throw Object.assign(new Error("SDK missing"), {
        code: "CLAUDE_SDK_UNAVAILABLE",
        statusCode: 503,
      });
    });
    assert.equal((await post(auth)).status, 503);

    // Host tools whose MCP bridge cannot be built (here: a non-string
    // description makes the build throw) fail the request instead of falling
    // back to Claude Code's native tools.
    calls = 0;
    setClaudeQueryStarter(async () => {
      calls += 1;
      throw new Error("must not start");
    });
    const brokenBridge = await post(auth, {
      ...chat,
      tools: [
        {
          type: "function",
          function: {
            name: "bash",
            description: { broken: true },
            parameters: { type: "object", properties: {} },
          },
        },
      ],
    });
    assert.equal(brokenBridge.status, 503);
    assert.equal(calls, 0, "no Claude Code turn without the OpenCode tool bridge");

    // stopProxy closes parked turns' Claude CLI children.
    let closed = false;
    const { promise: released, resolve: release } = Promise.withResolvers<void>();
    setClaudeQueryStarter(async (params) => {
      const server = (params.mcpServers as Record<string, any>).opencode;
      const handlers =
        server.instance.server?._requestHandlers ?? server.instance._requestHandlers;
      return {
        stream: (async function* () {
          yield { type: "system", subtype: "init", session_id: "park-sess" };
          handlers
            .get("tools/call")(
              { method: "tools/call", params: { name: "bash", arguments: {} } },
              {},
            )
            .catch(() => {});
          await released;
        })(),
        close: () => {
          closed = true;
          release();
        },
      };
    });
    const parked = await post(auth, {
      ...chat,
      tools: [
        {
          type: "function",
          function: {
            name: "bash",
            description: "Run a command",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
    });
    assert.equal(parked.status, 200);
    const parkedJson = (await parked.json()) as {
      choices: Array<{ message: { tool_calls?: Array<{ function: { name: string } }> } }>;
    };
    assert.equal(parkedJson.choices[0].message.tool_calls?.[0]?.function.name, "bash");
    assert.equal(closed, false);
    await stopProxy();
    assert.equal(closed, true, "stopProxy closes parked bridges");
    assert.equal(getProxyPort(), null);
  } finally {
    setClaudeQueryStarter(null);
    sibling.kill();
    await stopProxy();
  }
  console.log("ok — proxy security regression passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
