/**
 * Live Haiku matrix for opencode-claude.
 *
 * Exclusive model: haiku (claude-haiku-4-5) with effort=high.
 * Requires a logged-in Claude Code CLI + network.
 *
 * Run: bun test/haiku-live.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { encodeClaudeModelSelection } from "../src/model-selection.ts";
import {
  formatCompactNote,
  usageFromSdkResult,
} from "../src/usage.ts";
import {
  startProxy,
  stopProxy,
  getClaudeProxyBaseUrl,
  getProxyAuthToken,
} from "../src/proxy.ts";
import {
  EFFORT_HEADER,
  PROXY_TOKEN_HEADER,
  SESSION_HEADER,
} from "../src/constants.ts";
import { detectClaudeCode } from "../src/detect.ts";

type CaseResult = {
  id: string;
  ok: boolean;
  detail: string;
  usage?: unknown;
  ms: number;
};

const RESULTS: CaseResult[] = [];
const TOTAL_USAGE = {
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
  cost_usd: 0,
  turns: 0,
};

function accumulateUsage(usage: unknown): void {
  if (!usage || typeof usage !== "object") return;
  const u = usage as Record<string, unknown>;
  TOTAL_USAGE.prompt_tokens += Number(u.prompt_tokens || 0);
  TOTAL_USAGE.completion_tokens += Number(u.completion_tokens || 0);
  TOTAL_USAGE.total_tokens += Number(u.total_tokens || 0);
  TOTAL_USAGE.cost_usd += Number(u.cost_usd || 0);
  TOTAL_USAGE.turns += 1;
}

function effortHeader(effort: "high" | "low" | "medium" = "high"): string {
  return encodeClaudeModelSelection({ modelId: "haiku", effort });
}

async function chat(
  body: Record<string, unknown>,
  opts: { session?: string; stream?: boolean } = {},
): Promise<{
  status: number;
  json?: any;
  text: string;
  reasoning: string;
  toolCalls: any[];
  usage: any;
  finishReason: string | null;
  raw: string;
}> {
  const stream = opts.stream ?? false;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    [PROXY_TOKEN_HEADER]: getProxyAuthToken(),
    [EFFORT_HEADER]: effortHeader("high"),
  };
  if (opts.session) headers[SESSION_HEADER] = opts.session;

  const res = await fetch(`${getClaudeProxyBaseUrl()}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: "haiku",
      stream,
      ...body,
    }),
  });

  const raw = await res.text();
  if (!stream) {
    const json = JSON.parse(raw);
    const message = json.choices?.[0]?.message ?? {};
    return {
      status: res.status,
      json,
      text: String(message.content ?? ""),
      reasoning: String(message.reasoning_content ?? ""),
      toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : [],
      usage: json.usage ?? null,
      finishReason: json.choices?.[0]?.finish_reason ?? null,
      raw,
    };
  }

  let text = "";
  let reasoning = "";
  let usage: any = null;
  let finishReason: string | null = null;
  const toolCalls: any[] = [];
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6).trim();
    if (data === "[DONE]") continue;
    const chunk = JSON.parse(data);
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta ?? {};
    if (typeof delta.content === "string") text += delta.content;
    if (typeof delta.reasoning_content === "string") {
      reasoning += delta.reasoning_content;
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = typeof tc.index === "number" ? tc.index : toolCalls.length;
        if (!toolCalls[idx]) {
          toolCalls[idx] = {
            id: tc.id,
            type: "function",
            function: { name: "", arguments: "" },
          };
        }
        if (tc.id) toolCalls[idx].id = tc.id;
        if (tc.function?.name) toolCalls[idx].function.name = tc.function.name;
        if (tc.function?.arguments) {
          toolCalls[idx].function.arguments += tc.function.arguments;
        }
      }
    }
  }

  return {
    status: res.status,
    text,
    reasoning,
    toolCalls: toolCalls.filter(Boolean),
    usage,
    finishReason,
    raw,
  };
}

async function runCase(
  id: string,
  fn: () => Promise<{ detail: string; usage?: unknown }>,
): Promise<void> {
  const t0 = Date.now();
  try {
    const { detail, usage } = await fn();
    accumulateUsage(usage);
    RESULTS.push({ id, ok: true, detail, usage, ms: Date.now() - t0 });
    console.log(`PASS  ${id}  (${Date.now() - t0}ms)  ${detail}`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    RESULTS.push({ id, ok: false, detail, ms: Date.now() - t0 });
    console.error(`FAIL  ${id}  (${Date.now() - t0}ms)  ${detail}`);
  }
}

function b64(path: string): string {
  return readFileSync(path).toString("base64");
}

async function main() {
  // ---- Offline unit probes for usage/compact helpers ----
  await runCase("unit.usage_from_sdk_result", async () => {
    const usage = usageFromSdkResult({
      type: "result",
      is_error: false,
      total_cost_usd: 0.0012,
      modelUsage: {
        "claude-haiku-4-5": {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadInputTokens: 10,
          cacheCreationInputTokens: 5,
          costUSD: 0.0012,
          contextWindow: 200000,
          maxOutputTokens: 64000,
          webSearchRequests: 0,
        },
      },
    });
    assert.ok(usage);
    assert.equal(usage!.prompt_tokens, 100);
    assert.equal(usage!.completion_tokens, 20);
    assert.equal(usage!.total_tokens, 120);
    assert.equal(usage!.prompt_tokens_details?.cached_tokens, 10);
    assert.equal(usage!.cost_usd, 0.0012);
    return { detail: `tokens=${usage!.total_tokens} cost=${usage!.cost_usd}` };
  });

  await runCase("unit.compact_note", async () => {
    const note = formatCompactNote({
      trigger: "auto",
      pre_tokens: 180000,
      post_tokens: 12000,
      duration_ms: 321,
    });
    assert.match(note, /compact/);
    assert.match(note, /180000/);
    assert.match(note, /12000/);
    return { detail: note.trim() };
  });

  const detection = await detectClaudeCode();
  if (!detection.loggedIn) {
    console.error("SKIP live cases — Claude Code CLI is not logged in");
    printSummary();
    process.exit(RESULTS.some((r) => !r.ok) ? 1 : 0);
  }

  await stopProxy();
  await startProxy();

  // Health
  await runCase("proxy.health_models", async () => {
    const h = await fetch(`${getClaudeProxyBaseUrl().replace(/\/v1$/, "")}/health`);
    assert.equal(h.status, 200);
    const healthBody = (await h.json()) as {
      ok: boolean;
      rateLimit?: { limited?: boolean };
    };
    assert.equal(healthBody.ok, true);
    assert.equal(typeof healthBody.rateLimit?.limited, "boolean");
    const models = await fetch(`${getClaudeProxyBaseUrl()}/models`);
    assert.equal(models.status, 200);
    const body = (await models.json()) as { data: Array<{ id: string }> };
    assert.ok(body.data.some((m) => m.id === "haiku"));
    return {
      detail: `models=${body.data.map((m) => m.id).join(",")} limited=${healthBody.rateLimit?.limited}`,
    };
  });

  // Rate-limit counter endpoint (pre-turn shape)
  await runCase("proxy.rate_limit_endpoint", async () => {
    const res = await fetch(`${getClaudeProxyBaseUrl()}/rate-limit`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(typeof body.limited, "boolean");
    return {
      detail: `limited=${body.limited} status=${body.status ?? "n/a"} util=${body.utilization ?? "n/a"}`,
    };
  });

  // 1) Simple non-stream text + usage
  await runCase("haiku.text_nonstream_usage", async () => {
    const res = await chat(
      {
        messages: [
          {
            role: "user",
            content:
              "Reply with exactly the token OK_HAIKU_TEXT and nothing else.",
          },
        ],
      },
      { session: `test_text_${randomUUID()}`, stream: false },
    );
    assert.equal(res.status, 200);
    assert.match(res.text, /OK_HAIKU_TEXT/);
    assert.ok(res.usage, "expected usage object");
    assert.ok(res.usage.prompt_tokens > 0);
    assert.ok(res.usage.completion_tokens > 0);
    assert.ok(res.usage.total_tokens > 0);
    return {
      detail: `text=${res.text.trim()} usage=${JSON.stringify(res.usage)}`,
      usage: res.usage,
    };
  });

  // 2) Streaming + [DONE] + usage on final chunk
  await runCase("haiku.text_stream_usage", async () => {
    const res = await chat(
      {
        messages: [
          {
            role: "user",
            content: "Reply with exactly OK_STREAM and nothing else.",
          },
        ],
      },
      { session: `test_stream_${randomUUID()}`, stream: true },
    );
    assert.equal(res.status, 200);
    assert.match(res.text, /OK_STREAM/);
    assert.match(res.raw, /\[DONE\]/);
    assert.ok(res.usage, "expected streamed usage");
    assert.ok(res.usage.total_tokens > 0);
    return {
      detail: `text=${res.text.trim()} usage_total=${res.usage.total_tokens}`,
      usage: res.usage,
    };
  });

  // 3) Effort high — reasoning may appear
  await runCase("haiku.effort_high", async () => {
    const res = await chat(
      {
        messages: [
          {
            role: "user",
            content:
              "Think carefully, then reply with exactly EFFORT_HIGH_OK on its own line.",
          },
        ],
      },
      { session: `test_effort_${randomUUID()}`, stream: false },
    );
    assert.match(res.text, /EFFORT_HIGH_OK/);
    return {
      detail: `reasoning_len=${res.reasoning.length} usage=${res.usage?.total_tokens ?? 0}`,
      usage: res.usage,
    };
  });

  // 4) PNG attachment
  await runCase("haiku.attach_png", async () => {
    const png = b64("/tmp/haiku-matrix/red.png");
    const res = await chat(
      {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Dominant color one word (red/green/blue). Then OC_IMAGE_OK.",
              },
              {
                type: "image_url",
                image_url: { url: `data:image/png;base64,${png}` },
              },
            ],
          },
        ],
      },
      { session: `test_png_${randomUUID()}`, stream: false },
    );
    assert.match(res.text, /red/i);
    assert.match(res.text, /OC_IMAGE_OK/);
    return { detail: res.text.replace(/\s+/g, " ").trim(), usage: res.usage };
  });

  // 5) JPEG via AI SDK image shape
  await runCase("haiku.attach_jpeg_image_type", async () => {
    const jpg = b64("/tmp/test-photo.jpg");
    const res = await chat(
      {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Dominant color one word. Then OC_JPEG_OK if you see an image.",
              },
              { type: "image", image: `data:image/jpeg;base64,${jpg}` },
            ],
          },
        ],
      },
      { session: `test_jpeg_${randomUUID()}`, stream: false },
    );
    assert.match(res.text, /OC_JPEG_OK/);
    return { detail: res.text.replace(/\s+/g, " ").trim(), usage: res.usage };
  });

  // 6) PDF document
  await runCase("haiku.attach_pdf", async () => {
    const pdf = b64("/tmp/haiku-matrix/note.pdf");
    const res = await chat(
      {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  "Read the attached PDF carefully. Extract the exact visible text token on the page (letters only). Then write OC_PDF_OK on the next line.",
              },
              {
                type: "file",
                file: {
                  filename: "note.pdf",
                  file_data: `data:application/pdf;base64,${pdf}`,
                },
              },
            ],
          },
        ],
      },
      { session: `test_pdf_${randomUUID()}`, stream: false },
    );
    assert.match(res.text, /PDFTOKEN/i);
    assert.match(res.text, /OC_PDF_OK/);
    return { detail: res.text.replace(/\s+/g, " ").trim(), usage: res.usage };
  });

  // 7) Mixed attachments (image + text instruction)
  await runCase("haiku.attach_mixed_two_images", async () => {
    const red = b64("/tmp/haiku-matrix/red.png");
    const blue = b64("/tmp/haiku-matrix/blue.png");
    const res = await chat(
      {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Two images attached in order. Reply exactly: FIRST=<color> SECOND=<color> MIXED_OK",
              },
              {
                type: "image_url",
                image_url: { url: `data:image/png;base64,${red}` },
              },
              {
                type: "image_url",
                image_url: { url: `data:image/png;base64,${blue}` },
              },
            ],
          },
        ],
      },
      { session: `test_mixed_${randomUUID()}`, stream: false },
    );
    assert.match(res.text, /FIRST=\s*red/i);
    assert.match(res.text, /SECOND=\s*blue/i);
    assert.match(res.text, /MIXED_OK/);
    return { detail: res.text.replace(/\s+/g, " ").trim(), usage: res.usage };
  });

  // 8) Tool park + resume (MCP bridge)
  await runCase("haiku.tools_park_resume", async () => {
    const session = `test_tools_${randomUUID()}`;
    const tools = [
      {
        type: "function",
        function: {
          name: "get_secret",
          description: "Return a secret code for the given label",
          parameters: {
            type: "object",
            properties: { label: { type: "string" } },
            required: ["label"],
          },
        },
      },
    ];
    const first = await chat(
      {
        tools,
        messages: [
          {
            role: "user",
            content:
              "Call get_secret with label=alpha. Do not invent the result; use the tool.",
          },
        ],
      },
      { session, stream: false },
    );
    assert.equal(first.finishReason, "tool_calls");
    assert.ok(first.toolCalls.length >= 1);
    assert.equal(first.toolCalls[0].function.name, "get_secret");
    const toolCallId = first.toolCalls[0].id;
    assert.ok(toolCallId);

    const second = await chat(
      {
        tools,
        messages: [
          {
            role: "user",
            content:
              "Call get_secret with label=alpha. Do not invent the result; use the tool.",
          },
          {
            role: "assistant",
            tool_calls: first.toolCalls,
          },
          {
            role: "tool",
            tool_call_id: toolCallId,
            content: "SECRET_TOOL_VALUE_55",
          },
        ],
      },
      { session, stream: false },
    );
    assert.match(second.text, /SECRET_TOOL_VALUE_55/);
    return {
      detail: `parked=${first.toolCalls.length} resume=${second.text.replace(/\s+/g, " ").trim()} usage=${second.usage?.total_tokens ?? 0}`,
      usage: second.usage,
    };
  });

  // 9) Multi-tool park — resolve all pending tools in one follow-up
  await runCase("haiku.tools_multi_park", async () => {
    const session = `test_multitool_${randomUUID()}`;
    const tools = [
      {
        type: "function",
        function: {
          name: "add",
          description: "Add two integers a+b",
          parameters: {
            type: "object",
            properties: {
              a: { type: "number" },
              b: { type: "number" },
            },
            required: ["a", "b"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "mul",
          description: "Multiply two integers a*b",
          parameters: {
            type: "object",
            properties: {
              a: { type: "number" },
              b: { type: "number" },
            },
            required: ["a", "b"],
          },
        },
      },
    ];

    let messages: any[] = [
      {
        role: "user",
        content:
          "You must call BOTH tools in this turn: add(a=3,b=4) and mul(a=5,b=6). After tool results, reply exactly: SUM=7 PRODUCT=30 TOOLS_OK",
      },
    ];

    let guard = 0;
    let finalText = "";
    let lastUsage: any = null;
    while (guard++ < 4) {
      const turn = await chat(
        { tools, messages },
        { session, stream: false },
      );
      lastUsage = turn.usage;
      if (turn.finishReason === "tool_calls" && turn.toolCalls.length > 0) {
        messages = [
          ...messages,
          { role: "assistant", tool_calls: turn.toolCalls },
          ...turn.toolCalls.map((tc: any) => {
            const args = JSON.parse(tc.function.arguments || "{}");
            let result = "0";
            if (tc.function.name === "add") result = String(Number(args.a) + Number(args.b));
            if (tc.function.name === "mul") result = String(Number(args.a) * Number(args.b));
            return {
              role: "tool",
              tool_call_id: tc.id,
              content: result,
            };
          }),
        ];
        continue;
      }
      finalText = turn.text;
      break;
    }
    assert.match(finalText, /SUM\s*=\s*7/i);
    assert.match(finalText, /PRODUCT\s*=\s*30/i);
    assert.match(finalText, /TOOLS_OK/);
    return {
      detail: finalText.replace(/\s+/g, " ").trim(),
      usage: lastUsage,
    };
  });

  // 10) Session sticky resume (conversation continuity via foreign session id)
  await runCase("haiku.session_resume", async () => {
    const session = `test_resume_${randomUUID()}`;
    const first = await chat(
      {
        messages: [
          {
            role: "user",
            content:
              "For this coding session, the repository codename is NIGHTJAR. Reply with exactly STORED_OK.",
          },
        ],
      },
      { session, stream: false },
    );
    assert.match(first.text, /STORED_OK/);
    const second = await chat(
      {
        messages: [
          {
            role: "user",
            content:
              "What repository codename did I give you in this session? Reply with the codename only.",
          },
        ],
      },
      { session, stream: false },
    );
    assert.match(second.text, /NIGHTJAR/);
    return {
      detail: `resume=${second.text.trim()}`,
      usage: {
        prompt_tokens:
          (first.usage?.prompt_tokens ?? 0) + (second.usage?.prompt_tokens ?? 0),
        completion_tokens:
          (first.usage?.completion_tokens ?? 0) +
          (second.usage?.completion_tokens ?? 0),
        total_tokens:
          (first.usage?.total_tokens ?? 0) + (second.usage?.total_tokens ?? 0),
        cost_usd:
          (first.usage?.cost_usd ?? 0) + (second.usage?.cost_usd ?? 0),
      },
    };
  });

  // 11) Context pressure / compact awareness (soft)
  // Filling 200k is expensive; we send a large but bounded payload and assert
  // the turn completes with usage reflecting large prompt, and that compact
  // note formatting works (unit already covered). Live compact is best-effort.
  await runCase("haiku.context_large_prompt_usage", async () => {
    const blob = ("CONTEXT_PAD_LINE " + "x".repeat(200) + "\n").repeat(400);
    const res = await chat(
      {
        messages: [
          {
            role: "user",
            content: `${blob}\n\nIgnore the padding. Reply with exactly CONTEXT_OK.`,
          },
        ],
      },
      { session: `test_ctx_${randomUUID()}`, stream: false },
    );
    assert.match(res.text, /CONTEXT_OK/);
    assert.ok(res.usage?.prompt_tokens > 5000, "expected large prompt_tokens");
    const compactHit = /\[compact\]/i.test(res.reasoning);
    return {
      detail: `prompt_tokens=${res.usage.prompt_tokens} compact=${compactHit} reasoning_len=${res.reasoning.length}`,
      usage: res.usage,
    };
  });

  // 12) Empty messages → 400
  await runCase("haiku.empty_messages_400", async () => {
    const res = await chat(
      { messages: [] },
      { session: `test_empty_${randomUUID()}`, stream: false },
    );
    assert.equal(res.status, 400);
    return { detail: "status=400" };
  });

  // 12b) Rate-limit tracker recorded real SDK telemetry during live turns
  await runCase("haiku.rate_limit_recorded", async () => {
    const res = await fetch(`${getClaudeProxyBaseUrl()}/rate-limit`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(typeof body.limited, "boolean");
    // Live turns emit rate_limit_event → status/utilization must be recorded.
    assert.ok(
      typeof body.status === "string" && body.status.length > 0,
      `expected recorded limiter status, got ${JSON.stringify(body)}`,
    );
    assert.ok(body.updatedAt, "expected updatedAt");
    return {
      detail: `status=${body.status} util=${body.utilization ?? "n/a"} resetsAt=${body.resetsAtISO ?? "n/a"} limited=${body.limited}`,
    };
  });

  // 13) OpenCode CLI path with --file (PNG) — stop in-process proxy first
  // so OpenCode's plugin can bind its own ephemeral port.
  await runCase("haiku.opencode_cli_file_png", async () => {
    await stopProxy();
    // Wait briefly for port release
    await new Promise((r) => setTimeout(r, 500));
    const { spawnSync } = await import("node:child_process");
    const proc = spawnSync(
      "opencode",
      [
        "run",
        "--file",
        "/tmp/haiku-matrix/red.png",
        "--model",
        "claude-code/haiku",
        "--variant",
        "high",
        "--",
        "Dominant color one word, then OC_CLI_IMAGE_OK.",
      ],
      {
        cwd: "/tmp/oc-test",
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${process.env.HOME}/.local/bin:${process.env.HOME}/.bun/bin:${process.env.HOME}/.opencode/bin:${process.env.PATH}`,
          OPENCODE_CLAUDE_DEBUG: "1",
        },
        timeout: 120_000,
      },
    );
    const out = `${proc.stdout || ""}\n${proc.stderr || ""}`;
    assert.equal(proc.status, 0, out.slice(-1500));
    assert.match(out, /OC_CLI_IMAGE_OK/);
    assert.match(out, /red/i);
    // Restart proxy for any later cases (none currently)
    await startProxy();
    return { detail: "opencode --file PNG OK" };
  });

  await stopProxy();
  printSummary();
  process.exit(RESULTS.some((r) => !r.ok) ? 1 : 0);
}

function printSummary(): void {
  const passed = RESULTS.filter((r) => r.ok).length;
  const failed = RESULTS.filter((r) => !r.ok).length;
  console.log("\n========== HAIKU MATRIX SUMMARY ==========");
  console.log(`cases: ${RESULTS.length}  pass: ${passed}  fail: ${failed}`);
  console.log(
    `usage totals: prompt=${TOTAL_USAGE.prompt_tokens} completion=${TOTAL_USAGE.completion_tokens} total=${TOTAL_USAGE.total_tokens} cost_usd≈${TOTAL_USAGE.cost_usd.toFixed(6)} turns=${TOTAL_USAGE.turns}`,
  );
  for (const r of RESULTS) {
    console.log(`${r.ok ? "✓" : "✗"} ${r.id} (${r.ms}ms) — ${r.detail}`);
  }
  console.log("==========================================\n");
}

main().catch(async (err) => {
  console.error(err);
  try {
    await stopProxy();
  } catch {
    // ignore
  }
  process.exit(1);
});
