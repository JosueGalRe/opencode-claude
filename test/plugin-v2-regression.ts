/**
 * Regression: the V2 setup registers the claude-code provider against the
 * live proxy (catalog, limits, effort variants), the Claude CLI sign-in
 * integration, and per-request session/effort/directory/request-kind headers.
 *
 * Run: bun test/plugin-v2-regression.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), "opencode-claude-v2-"));
  process.env.XDG_DATA_HOME = tmp;
  process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE = join(tmp, "rate-limit.json");

  const {
    DIRECTORY_HEADER,
    EFFORT_HEADER,
    PROVIDER_ID,
    PROXY_TOKEN_HEADER,
    REQUEST_KIND_HEADER,
    SESSION_HEADER,
  } = await import("../src/constants.ts");
  const { decodeClaudeModelSelection } = await import(
    "../src/model-selection.ts"
  );
  const { getClaudeModels, refreshClaudeModels } = await import("../src/models.ts");
  await refreshClaudeModels(async () => [
    { value: "sonnet", resolvedModel: "claude-sonnet-5-5", supportedEffortLevels: ["low", "high"] },
    { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", supportedEffortLevels: [] },
  ]);
  const { getClaudeProxyBaseUrl, getProxyAuthToken, getProxyPort } =
    await import("../src/proxy.ts");
  const plugin = (await import("../src/index.ts")).default;

  // One entrypoint serves both loaders: V2 reads id/setup, V1 calls server().
  assert.equal(plugin.id, "opencode-claude");
  assert.equal(typeof plugin.setup, "function");
  assert.equal(typeof plugin.server, "function");

  let added: { info: any; models: any[] } | null = null;
  let methodRegistration: any = null;
  const hooks = new Map<string, (event: any) => Promise<void>>();
  const stopEvents: Array<{
    type: "session.execution.interrupted" | "session.execution.failed";
    data: { sessionID: string };
  }> = [];
  const subscriptions: AbortSignal[] = [];
  let wakeEvents: (() => void) | undefined;
  const emitStop = (event: typeof stopEvents[number]) => {
    stopEvents.push(event);
    wakeEvents?.();
  };

  const ctx = {
    location: { directory: "/work/project" },
    event: {
      subscribe({ signal }: { signal: AbortSignal }) {
        subscriptions.push(signal);
        return (async function* () {
          while (!signal.aborted) {
            if (stopEvents.length === 0) {
              await new Promise<void>((resolve) => {
                wakeEvents = resolve;
                signal.addEventListener("abort", resolve, { once: true });
              });
            }
            if (signal.aborted) return;
            const event = stopEvents.shift();
            if (event) yield event;
          }
        })();
      },
    },
    provider: {
      async transform(callback: (editor: any) => void) {
        callback({
          add(input: any) {
            added = input;
          },
        });
        return { async dispose() {} };
      },
    },
    integration: {
      async transform(callback: (editor: any) => void) {
        callback({
          update(_id: string, update: (draft: any) => void) {
            const draft = { name: PROVIDER_ID };
            update(draft);
            assert.equal(draft.name, "Claude Code");
          },
          method: {
            update(input: any) {
              methodRegistration = input;
            },
          },
        });
        return { async dispose() {} };
      },
    },
    session: {
      async hook(name: string, callback: (event: any) => void) {
        hooks.set(name, callback);
        return { async dispose() {} };
      },
    },
  };

  const cleanup = await plugin.setup(ctx as never);
  try {
    const { getBridge, putBridge } = await import("../src/bridge-pool.ts");
    let stopped = () => {};
    const stoppedTurn = new Promise<void>((resolve) => { stopped = resolve; });
    const bridge = (sessionID: string, close: () => void) => ({
      id: sessionID,
      conversationKey: sessionID,
      handle: { stream: (async function* () {})(), close },
      pendingTools: new Map(),
      seenAssistantUsageIds: new Set<string>(),
      resume: async function* () {},
    });
    putBridge(bridge("sess-stopped", stopped));
    putBridge(bridge("sess-other", () => {}));
    emitStop({ type: "session.execution.interrupted", data: { sessionID: "sess-stopped" } });
    await stoppedTurn;
    assert.equal(getBridge("sess-stopped"), undefined);
    assert.ok(getBridge("sess-other"), "other session keeps its parked turn");
    let failed = () => {};
    const failedTurn = new Promise<void>((resolve) => { failed = resolve; });
    putBridge(bridge("sess-failed", failed));
    emitStop({ type: "session.execution.failed", data: { sessionID: "sess-failed" } });
    await failedTurn;
    assert.equal(getBridge("sess-failed"), undefined);
    assert.ok(getBridge("sess-other"));
    assert.ok(getProxyPort(), "proxy started by setup");
    assert.ok(added, "provider registered");
    assert.equal(added!.info.name, "Claude Code");
    assert.equal(added!.info.package, "@opencode/ai/providers/openai-compatible");
    assert.equal(added!.info.integrationID, PROVIDER_ID);
    assert.equal(added!.info.settings.baseURL, getClaudeProxyBaseUrl());
    // The proxy secret rides on both paths: the saved connection-marker
    // credential may replace the API key, never the dedicated header.
    const token = getProxyAuthToken();
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.equal(added!.info.settings.apiKey, token);

    const models = added!.models;
    assert.equal(models.length, getClaudeModels().length);
    const sonnet = models.find((m) => m.id === "claude-sonnet-5-5[1m]");
    assert.ok(sonnet);
    assert.equal(sonnet.limit.input, 900_000);
    assert.equal(sonnet.limit.output, 128_000);
    assert.deepEqual(
      sonnet.capabilities.input,
      ["text", "image", "pdf"],
    );
    assert.deepEqual(
      sonnet.variants.map((v: { id: string }) => v.id),
      ["low", "high"],
    );
    assert.deepEqual(models.find((m) => m.id === "claude-haiku-4-5-20251001")?.variants, []);

    assert.ok(methodRegistration, "integration method registered");
    assert.equal(methodRegistration.integrationID, PROVIDER_ID);
    assert.equal(methodRegistration.method.type, "oauth");
    assert.equal(typeof methodRegistration.authorize, "function");
    assert.equal(typeof methodRegistration.refresh, "function");

    const onModelRequest = hooks.get("model.request");
    assert.ok(onModelRequest, "model.request hook registered");
    const event = {
      sessionID: "sess-v2",
      model: { providerID: PROVIDER_ID, id: "sonnet", variant: "high" },
      kind: "compaction",
      headers: {} as Record<string, string>,
    };
    await onModelRequest!(event);
    assert.equal(event.baseURL, getClaudeProxyBaseUrl());
    assert.deepEqual(decodeClaudeModelSelection(event.headers[EFFORT_HEADER]), {
      modelId: "sonnet",
      effort: "high",
    });
    assert.equal(event.headers[SESSION_HEADER], "sess-v2");
    assert.equal(event.headers[DIRECTORY_HEADER], "/work/project");
    assert.equal(event.headers[PROXY_TOKEN_HEADER], token);
    assert.equal(event.headers[REQUEST_KIND_HEADER], "compaction");

    // The token is what the live proxy demands: a V2 request shaped like the
    // host's (marker bearer + hook headers) is admitted, one without the
    // header is refused. The body has no user turn, so an admitted request
    // stops at validation (400) and never starts the Claude CLI.
    const url = `${getClaudeProxyBaseUrl()}/chat/completions`;
    const body = JSON.stringify({ model: "sonnet", messages: [] });
    const refused = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer managed-by-claude-code-cli",
      },
      body,
    });
    assert.equal(refused.status, 401);
    const admitted = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer managed-by-claude-code-cli",
        ...event.headers,
      },
      body,
    });
    assert.equal(admitted.status, 400, "authorized request reaches validation");

    const { setClaudeQueryStarter } = await import("../src/proxy.ts");
    setClaudeQueryStarter(async () => ({
      stream: (async function* () {
        yield {
          type: "system", subtype: "model_refusal_fallback",
          original_model: "claude-fable-5-1", fallback_model: "claude-opus-5-5",
          api_refusal_category: "bio",
        };
        yield { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "answer" } } };
        yield { type: "result", is_error: false, usage: {} };
      })(),
      close: () => {},
    }));
    try {
      const fallback = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", [PROXY_TOKEN_HEADER]: token,
          [SESSION_HEADER]: "sess-fallback" },
        body: JSON.stringify({ model: "sonnet", stream: true,
          messages: [{ role: "user", content: "question" }] }),
      });
      assert.equal(fallback.status, 200);
      const text = await fallback.text();
      assert.match(text, /reasoning_content/);
      assert.match(text, /claude-fable-5-1 declined this request \(bio\); claude-opus-5-5 answered/);
    } finally {
      setClaudeQueryStarter(null);
    }

    // Other providers are untouched.
    const foreign = {
      sessionID: "s",
      model: { providerID: "openai", id: "gpt-5" },
      headers: {} as Record<string, string>,
    };
    await onModelRequest!(foreign);
    assert.deepEqual(foreign.headers, {});
    const otherCleanup = await plugin.setup(ctx as never);
    await (cleanup as () => Promise<void>)();
    assert.ok(getProxyPort(), "another location still holds the proxy");
    await onModelRequest!(event);
    assert.equal(event.baseURL, getClaudeProxyBaseUrl());
    await (otherCleanup as () => Promise<void>)();
    assert.ok(subscriptions.every((signal) => signal.aborted), "cleanup aborts event streams");
  } finally {
    await (cleanup as (() => Promise<void>) | undefined)?.();
  }
  assert.equal(getProxyPort(), null, "cleanup stops the proxy");
  console.log("ok — plugin V2 regression passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
