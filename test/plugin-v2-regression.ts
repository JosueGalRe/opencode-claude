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
  const { getClaudeModels } = await import("../src/models.ts");
  const { getClaudeProxyBaseUrl, getProxyAuthToken, getProxyPort } =
    await import("../src/proxy.ts");
  const plugin = (await import("../src/index.ts")).default;

  // One entrypoint serves both loaders: V2 reads id/setup, V1 calls server().
  assert.equal(plugin.id, "opencode-claude");
  assert.equal(typeof plugin.setup, "function");
  assert.equal(typeof plugin.server, "function");

  let added: { info: any; models: any[] } | null = null;
  let methodRegistration: any = null;
  const hooks = new Map<string, (event: any) => void>();

  const ctx = {
    location: { directory: "/work/project" },
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
    const sonnet = models.find((m) => m.id === "sonnet");
    assert.ok(sonnet);
    assert.equal(sonnet.limit.input, 900_000);
    assert.equal(sonnet.limit.output, 128_000);
    assert.deepEqual(
      sonnet.capabilities.input,
      ["text", "image", "pdf"],
    );
    assert.deepEqual(
      sonnet.variants.map((v: { id: string }) => v.id),
      ["low", "medium", "high", "xhigh", "max"],
    );

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
    onModelRequest!(event);
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

    // Other providers are untouched.
    const foreign = {
      sessionID: "s",
      model: { providerID: "openai", id: "gpt-5" },
      headers: {} as Record<string, string>,
    };
    onModelRequest!(foreign);
    assert.deepEqual(foreign.headers, {});
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
