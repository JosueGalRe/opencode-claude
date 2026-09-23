/**
 * Local OpenAI-compatible proxy → Claude Agent SDK.
 *
 * Accepts POST /v1/chat/completions, runs Claude Code via the Agent SDK
 * (OpenChamber harness approach), streams OpenAI-format SSE.
 *
 * Tool calls from OpenCode are exposed as an in-process MCP server. When Claude
 * invokes one, the stream parks (Cursor bridge-pool pattern) and returns
 * tool_calls; the follow-up request with tool results resumes the turn.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  clearAllBridges,
  deleteBridge,
  deleteBridgesByConversation,
  findBridgeByConversation,
  findBridgeByPendingTool,
  putBridge,
  type ParkedBridge,
  type ParkedToolCall,
} from "./bridge-pool.js";
import { buildClaudeCodeChildEnv } from "./auth-env.js";
import {
  classifyClaudeFailure,
  failureHintFor,
  failureStatusFor,
  failureTypeFor,
  rateLimitResponse,
} from "./failure.js";
import {
  decodeClaudeModelSelection,
  EFFORT_HEADER,
} from "./model-selection.js";
import { resolveClaudeModelId } from "./models.js";
import { collectSteeringText, withSteering } from "./steering.js";
import { claudeCodePreset } from "./system-context.js";
import {
  bridgedToolAliases,
  bridgedToolName,
  buildOpenCodeMcpServer,
  openCodeToolNames,
  type OpenAITool,
} from "./tool-bridge.js";
import { TurnRunner } from "./turn-runner.js";
import {
  DIRECTORY_HEADER,
  PROXY_TOKEN_HEADER,
  SESSION_HEADER,
  type ClaudeEffort,
} from "./constants.js";
import { startClaudeQuery } from "./query.js";
import {
  clearForeignSessionId,
  conversationKeyFromMessages,
  findClaudeSessionFile,
  getForeignSessionId,
  getSessionBinding,
  historyFingerprint,
  nonSystemMessages,
  setForeignSessionId,
  setHistoryFingerprint,
} from "./session-store.js";
import { log } from "./log.js";
import {
  getRateLimitSnapshot,
  maybeRateLimitNote,
  normalizeClaudeErrorText,
  rateLimitGate,
  recordRateLimitErrorText,
  recordRateLimitInfo,
  formatResetCountdown,
} from "./rate-limit.js";
import {
  buildConversationTranscript,
  extractTextContent,
  latestUserPrompt,
  openaiContentToAnthropicBlocks,
  openaiToolResultToMcpContent,
  priorMessagesOf,
  promptAsStream,
  SYNTHETIC_TOOL_MEDIA_PROMPT,
  withConversationContext,
  type AnthropicContentBlock,
  type McpToolResultContent,
  type SdkUserPrompt,
} from "./prompt.js";
import {
  detectMetaRequestKind,
  latestUserMessage,
  requestKeyNamespace,
  titlePrompt,
} from "./request-kind.js";
import {
  formatCompactNote,
  TurnUsage,
  usageFromAssistantEvent,
  usageFromSdkResult,
  usageFromSdkTurnResult,
  usageFromStreamEvent,
  type OpenAIUsage,
  type StreamUsageEvent,
} from "./usage.js";

const SHARED_PROXY_HEALTH_TIMEOUT_MS = 750;

/** OPENCODE_CLAUDE_HOST_TRANSCRIPT=0 disables host-history divergence detection. */
function hostTranscriptWatchEnabled(): boolean {
  const raw = (process.env.OPENCODE_CLAUDE_HOST_TRANSCRIPT ?? "")
    .trim()
    .toLowerCase();
  return !["0", "false", "off", "no"].includes(raw);
}

/**
 * Bun.serve defaults to 10s and RSTs idle sockets. OpenCode maps that to a
 * retryable "Connection reset by server". This proxy holds the HTTP response
 * until the Claude turn proves alive, and SSE can pause during thinking —
 * both exceed 10s easily. 0 disables the timer (same as OpenCode's adapter).
 */
export const PROXY_IDLE_TIMEOUT_SECONDS = 0;
export const SSE_HEARTBEAT_MS = 5_000;

/**
 * Optional pinned port via OPENCODE_CLAUDE_PROXY_PORT.
 * Default is `0` — Bun binds an ephemeral free port; the live URL is then
 * published through the config hook so OpenCode always hits the
 * process that owns the listener (no static 8787 requirement).
 */
const REQUESTED_PROXY_PORT: number = (() => {
  const raw = process.env.OPENCODE_CLAUDE_PROXY_PORT;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isInteger(parsed) && parsed >= 0 && parsed < 65536
    ? parsed
    : 0;
})();

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
} as const;

type OpenAIMessage = {
  role?: string;
  content?: unknown;
  tool_calls?: Array<{
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }>;
  tool_call_id?: string;
  name?: string;
};

type ChatCompletionRequest = {
  model?: string;
  messages?: OpenAIMessage[];
  tools?: OpenAITool[];
  stream?: boolean;
  temperature?: number;
};

let server: ReturnType<typeof Bun.serve> | null = null;
let proxyPort: number | null = null;

/** Injectable for smoke tests — production path always uses startClaudeQuery. */
let queryStarter: typeof startClaudeQuery = startClaudeQuery;

export function setClaudeQueryStarter(
  starter: typeof startClaudeQuery | null,
): void {
  queryStarter = starter ?? startClaudeQuery;
}

export function getClaudeProxyBaseUrl(): string {
  const port = proxyPort ?? (REQUESTED_PROXY_PORT > 0 ? REQUESTED_PROXY_PORT : null);
  if (!port) {
    throw new Error(
      "Claude proxy is not listening yet — call startProxy() before getClaudeProxyBaseUrl()",
    );
  }
  return `http://127.0.0.1:${port}/v1`;
}

export function getProxyPort(): number | null {
  return proxyPort;
}

/**
 * Secret the plugin sends on every chat request (Bearer or PROXY_TOKEN_HEADER)
 * so no other local process or browser page can drive Claude Code through
 * this listener. A pinned port may be served by a sibling OpenCode process,
 * so pinned mode shares one token through a 0600 file in the data dir.
 */
let proxyAuthToken: string | null = null;

const PROXY_TOKEN_PATTERN = /^[0-9a-f]{64}$/;

function readSharedProxyToken(path: string): string | null {
  try {
    const token = readFileSync(path, "utf8").trim();
    if (!PROXY_TOKEN_PATTERN.test(token)) return null;
    if ((statSync(path).mode & 0o077) !== 0) chmodSync(path, 0o600);
    return token;
  } catch {
    return null;
  }
}

function sharedProxyToken(): string {
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg ? xdg : join(homedir(), ".local", "share");
  const path = join(base, "opencode-claude", "proxy-token");
  const existing = readSharedProxyToken(path);
  if (existing) return existing;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("hex");
  // Publish atomically: a sibling must never read a half-written token.
  const tmp = `${path}.${process.pid}.${randomUUID()}`;
  writeFileSync(tmp, token, { mode: 0o600 });
  try {
    linkSync(tmp, path);
    return token;
  } catch (err) {
    if ((err as { code?: unknown }).code !== "EEXIST") throw err;
    // A sibling published first; theirs wins unless it is unusable.
    const raced = readSharedProxyToken(path);
    if (raced) return raced;
    renameSync(tmp, path);
    return token;
  } finally {
    rmSync(tmp, { force: true });
  }
}

export function getProxyAuthToken(): string {
  proxyAuthToken ??=
    REQUESTED_PROXY_PORT > 0
      ? sharedProxyToken()
      : randomBytes(32).toString("hex");
  return proxyAuthToken;
}

function proxyTokenMatches(candidate: string | undefined): boolean {
  if (!candidate) return false;
  // Hash both sides so timingSafeEqual gets equal lengths.
  const given = createHash("sha256").update(candidate).digest();
  const expected = createHash("sha256").update(getProxyAuthToken()).digest();
  return timingSafeEqual(given, expected);
}

/** Either credential may carry the token; V2 hosts may overwrite the Bearer. */
function isAuthorizedChatRequest(req: Request): boolean {
  const bearer = /^Bearer\s+(\S+)\s*$/i.exec(
    req.headers.get("authorization") ?? "",
  )?.[1];
  return (
    proxyTokenMatches(bearer) ||
    proxyTokenMatches(req.headers.get(PROXY_TOKEN_HEADER)?.trim())
  );
}

function isAddrInUseError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  const message = (err as { message?: unknown }).message;
  return (
    code === "EADDRINUSE" ||
    (typeof message === "string" &&
      /eaddrinuse|address already in use|in use/i.test(message))
  );
}

async function isProxyHealthyAt(baseUrl: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    SHARED_PROXY_HEALTH_TIMEOUT_MS,
  );
  try {
    const res = await fetch(`${baseUrl}/models`, {
      signal: controller.signal,
    });
    if (!res.ok) return false;
    const body = (await res.json().catch(() => undefined)) as
      | { object?: unknown; data?: unknown }
      | undefined;
    return (
      !!body &&
      body.object === "list" &&
      Array.isArray(body.data)
    );
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function bindProxy(): number {
  const bound = Bun.serve({
    hostname: "127.0.0.1",
    port: REQUESTED_PROXY_PORT, // 0 → ephemeral
    idleTimeout: PROXY_IDLE_TIMEOUT_SECONDS,
    async fetch(req) {
      return handleRequest(req);
    },
  });
  if (!bound.port) {
    bound.stop(true);
    throw new Error("Failed to bind Claude proxy to a port");
  }
  stopSiblingWatch();
  server = bound;
  proxyPort = bound.port;
  log.info(`[opencode-claude] proxy listening on ${getClaudeProxyBaseUrl()}`);
  return proxyPort;
}

const SIBLING_WATCH_INTERVAL_MS = 5_000;
let siblingWatch: ReturnType<typeof setInterval> | null = null;

function stopSiblingWatch(): void {
  if (siblingWatch) clearInterval(siblingWatch);
  siblingWatch = null;
}

/**
 * This process forwards to a sibling's listener on the pinned port. When
 * that sibling exits, take the port over instead of pointing OpenCode at a
 * dead listener until restart.
 */
function reuseSiblingProxy(message: string): number {
  proxyPort = REQUESTED_PROXY_PORT;
  log.info(message);
  if (siblingWatch) return proxyPort;
  const pinnedUrl = `http://127.0.0.1:${REQUESTED_PROXY_PORT}/v1`;
  let checking = false;
  const timer = setInterval(async () => {
    if (checking) return;
    checking = true;
    try {
      if (await isProxyHealthyAt(pinnedUrl)) return;
      // stopProxy (or a local bind) may have run during the health check.
      if (siblingWatch !== timer || server) return;
      try {
        bindProxy();
        log.info(
          `[opencode-claude] sibling proxy on port ${REQUESTED_PROXY_PORT} stopped; took over the listener`,
        );
      } catch (err) {
        // Another sibling won the race for the port; keep watching it.
        if (!isAddrInUseError(err)) {
          log.warn("[opencode-claude] failed to take over pinned proxy port", {
            port: REQUESTED_PROXY_PORT,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } finally {
      checking = false;
    }
  }, SIBLING_WATCH_INTERVAL_MS);
  timer.unref?.();
  siblingWatch = timer;
  return proxyPort;
}

export async function startProxy(): Promise<number> {
  if (server && proxyPort) return proxyPort;
  // Create/load the shared token before a sibling can serve our requests.
  getProxyAuthToken();

  // Only reuse a sibling listener when the operator pinned a port.
  if (REQUESTED_PROXY_PORT > 0) {
    const pinnedUrl = `http://127.0.0.1:${REQUESTED_PROXY_PORT}/v1`;
    if (await isProxyHealthyAt(pinnedUrl)) {
      return reuseSiblingProxy(
        `[opencode-claude] reusing healthy proxy on ${pinnedUrl}`,
      );
    }
  }

  try {
    return bindProxy();
  } catch (err) {
    if (
      REQUESTED_PROXY_PORT > 0 &&
      isAddrInUseError(err) &&
      (await isProxyHealthyAt(`http://127.0.0.1:${REQUESTED_PROXY_PORT}/v1`))
    ) {
      return reuseSiblingProxy(
        `[opencode-claude] port ${REQUESTED_PROXY_PORT} in use; reusing existing proxy`,
      );
    }
    throw err;
  }
}

export async function stopProxy(): Promise<void> {
  stopSiblingWatch();
  // Parked turns each hold a live claude CLI child; nothing resumes them now.
  clearAllBridges();
  if (server) {
    server.stop(true);
    server = null;
  }
  proxyPort = null;
}

function errorResponse(status: number, type: string, message: string): Response {
  return Response.json({ error: { message, type } }, { status });
}

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);

  if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/v1/health")) {
    const rateLimit = getRateLimitSnapshot();
    return Response.json({
      ok: true,
      provider: "claude-code",
      rateLimit: {
        limited: rateLimit.limited,
        ...(rateLimit.resetsAtISO ? { resetsAt: rateLimit.resetsAtISO } : {}),
        ...(rateLimit.resetInSeconds !== undefined
          ? { resetInSeconds: rateLimit.resetInSeconds }
          : {}),
        ...(rateLimit.utilization !== undefined
          ? { utilization: rateLimit.utilization }
          : {}),
      },
    });
  }

  // Live "when are limits back" counter for OpenChamber / OpenCode UIs.
  if (
    req.method === "GET" &&
    (url.pathname === "/rate-limit" || url.pathname === "/v1/rate-limit")
  ) {
    return Response.json(getRateLimitSnapshot());
  }

  if (req.method === "GET" && url.pathname === "/v1/models") {
    const { getClaudeModels } = await import("./models.js");
    return Response.json({
      object: "list",
      data: getClaudeModels().map((m) => ({
        id: m.id,
        object: "model",
        owned_by: "claude-code",
      })),
    });
  }

  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    // Browsers always attach Origin to cross-origin POSTs; OpenCode's
    // server-side provider fetch never does.
    const origin = req.headers.get("origin");
    if (origin !== null) {
      log.warn("[opencode-claude] rejected browser-origin chat request", { origin });
      return errorResponse(
        403,
        "permission_error",
        "Browser-origin requests to the Claude proxy are not allowed",
      );
    }
    if (!isAuthorizedChatRequest(req)) {
      log.warn("[opencode-claude] rejected chat request without a valid proxy token");
      return errorResponse(
        401,
        "authentication_error",
        "Missing or invalid opencode-claude proxy token",
      );
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return errorResponse(
        400,
        "invalid_request_error",
        `Request body is not valid JSON: ${detail}`,
      );
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return errorResponse(
        400,
        "invalid_request_error",
        "Request body must be a JSON object",
      );
    }

    try {
      return await handleChatCompletions(req, body as ChatCompletionRequest);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Errors such as CLAUDE_SDK_UNAVAILABLE carry their own HTTP status.
      const carried =
        err && typeof err === "object"
          ? (err as { statusCode?: unknown }).statusCode
          : undefined;
      const status =
        typeof carried === "number" &&
        Number.isInteger(carried) &&
        carried >= 400 &&
        carried < 600
          ? carried
          : 500;
      log.error("[opencode-claude] chat completions error", { status, message });
      return errorResponse(
        status,
        status < 500 ? "invalid_request_error" : "server_error",
        message,
      );
    }
  }

  return new Response("Not Found", { status: 404 });
}

/** OpenCode's promoted tool-result media message; not a user turn. */
function isPromotedToolMedia(msg: OpenAIMessage): boolean {
  return (
    msg.role === "user" &&
    extractTextContent(msg.content).trim() === SYNTHETIC_TOOL_MEDIA_PROMPT
  );
}

/**
 * The step OpenCode answers in this request: the last assistant message and
 * the tool results after it. Tool messages of earlier steps are history.
 */
type AnsweredToolStep = {
  assistantIndex: number;
  /** MCP result per tool_call_id, in message order. */
  results: Map<string, McpToolResultContent[]>;
  /**
   * OpenCode promotes tool-result media into a synthetic user message
   * ("Attached media from tool result:") after the step for providers that
   * cannot carry media inside tool results — every openai-compatible
   * provider. Only this step's message counts: OpenCode re-sends the ones of
   * earlier steps on every request.
   */
  media: McpToolResultContent[];
};

function collectAnsweredToolStep(
  messages: OpenAIMessage[],
): AnsweredToolStep | null {
  let assistantIndex = messages.length - 1;
  while (assistantIndex >= 0 && messages[assistantIndex]?.role !== "assistant") {
    assistantIndex--;
  }
  if (assistantIndex < 0) return null;
  const results = new Map<string, McpToolResultContent[]>();
  const media: McpToolResultContent[] = [];
  for (const msg of messages.slice(assistantIndex + 1)) {
    if (msg.role === "tool" && msg.tool_call_id) {
      results.set(msg.tool_call_id, openaiToolResultToMcpContent(msg.content));
    } else if (isPromotedToolMedia(msg)) {
      media.push(
        ...openaiToolResultToMcpContent(msg.content).filter(
          (b) => !(b.type === "text" && b.text.trim() === SYNTHETIC_TOOL_MEDIA_PROMPT),
        ),
      );
    }
  }
  return results.size > 0 ? { assistantIndex, results, media } : null;
}

/**
 * Prompt for tool results no parked turn waits for (proxy restart, cancelled
 * or reaped bridge, superseded turn). The Claude session that made the calls
 * cannot take their results any more, so the turn is rebuilt: the history
 * before the step is transferred as usual, and this prompt carries the step
 * itself — the calls, their full results with media, and any user messages
 * sent after them.
 */
function answeredToolStepPrompt(
  messages: OpenAIMessage[],
  step: AnsweredToolStep,
): SdkUserPrompt {
  const assistant = messages[step.assistantIndex];
  const content: AnthropicContentBlock[] = [
    {
      type: "text",
      text: "<tool_results>\nYour previous step called the tools below, but the session that made those calls ended before OpenCode returned their results. They are relayed here. Do not repeat a call unless its result requires it.",
    },
  ];
  const stepText = extractTextContent(assistant.content).trim();
  if (stepText) {
    content.push({ type: "text", text: `Your message in that step:\n${stepText}` });
  }
  const calls = new Map(
    (assistant.tool_calls ?? []).map((call) => [call.id, call.function]),
  );
  const userBlocks: AnthropicContentBlock[] = [];
  for (const msg of messages.slice(step.assistantIndex + 1)) {
    if (msg.role === "tool" && msg.tool_call_id) {
      const call = calls.get(msg.tool_call_id);
      const blocks = openaiContentToAnthropicBlocks(msg.content);
      content.push(
        {
          type: "text",
          text: `Result of ${call?.name ?? msg.name ?? "tool"} ${call?.arguments ?? ""} (${msg.tool_call_id}):`,
        },
        ...(blocks.length > 0 ? blocks : [{ type: "text" as const, text: "(no output)" }]),
      );
    } else if (isPromotedToolMedia(msg)) {
      content.push(
        { type: "text", text: "Media attached to these tool results:" },
        ...openaiContentToAnthropicBlocks(msg.content).filter(
          (b) => !(b.type === "text" && b.text.trim() === SYNTHETIC_TOOL_MEDIA_PROMPT),
        ),
      );
    } else if (msg.role === "user") {
      userBlocks.push(...openaiContentToAnthropicBlocks(msg.content));
    }
  }
  content.push({
    type: "text",
    text:
      userBlocks.length > 0
        ? "</tool_results>\n\nThe user sent the following after those calls. Respond to it with the results in mind:"
        : "</tool_results>\n\nContinue the task from these results.",
  });
  content.push(...userBlocks);
  return {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
  };
}

/**
 * `delta`: host messages from the first user message of the latest turn the
 * bound Claude session was given (queued user messages travel together).
 * Claude's own output — assistant messages, tool results, promoted media —
 * and user messages still waiting for an answer are expected there. A user
 * message followed by an assistant answer means another provider answered a
 * turn this session never saw: the user switched the OpenCode session away
 * and back.
 */
function answeredElsewhere(delta: OpenAIMessage[]): boolean {
  let sawAssistant = false;
  let unansweredUser = false;
  for (const msg of delta) {
    if (msg.role === "assistant") {
      if (unansweredUser) return true;
      sawAssistant = true;
    } else if (msg.role === "user" && sawAssistant && !isPromotedToolMedia(msg)) {
      unansweredUser = true;
    }
  }
  return false;
}

/** Tear the turn down if the client disconnects before `work` settles. */
async function closeTurnOnAbort<T>(
  signal: AbortSignal,
  bridgeId: string,
  work: () => Promise<T>,
): Promise<T> {
  const abort = () => deleteBridge(bridgeId);
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  try {
    return await work();
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

function selectionFromRequest(
  req: Request,
  body: ChatCompletionRequest,
): { modelId: string; effort?: ClaudeEffort } {
  const header = req.headers.get(EFFORT_HEADER);
  const decoded = decodeClaudeModelSelection(header);
  const modelId =
    decoded?.modelId ||
    (typeof body.model === "string" ? body.model.replace(/^claude-code\//, "") : "sonnet");
  const effort = decoded?.effort;
  return { modelId, ...(effort ? { effort } : {}) };
}

/**
 * Answer the request with `events`: an SSE stream, or one buffered JSON
 * completion that tears the turn down if the client leaves first.
 */
function turnResponse(
  req: Request,
  events: AsyncIterable<unknown>,
  model: string,
  bridge: ParkedBridge,
  stream: boolean,
  options?: { suppressReasoning?: boolean },
): Response | Promise<Response> {
  return stream
    ? streamOpenAIResponse(events, model, bridge, options)
    : closeTurnOnAbort(req.signal, bridge.id, () =>
        collectTurnResponse(events, model, bridge, options),
      );
}

/**
 * A resumed Claude session only receives the latest user turn; the rest of
 * the host array must already be in its transcript. Two ways it is not:
 * - host-side history rewrites (context-pruning plugins like DCP, message
 *   transforms): the prefix the session saw no longer hashes the same;
 * - turns answered by another provider (the user switched the OpenCode
 *   session away and back): user turns answered after that prefix.
 * Either way drop the binding so the turn transfers the host's history
 * instead of resuming.
 */
function dropDivergedSession(
  conversationKey: string,
  priorMessages: OpenAIMessage[],
): void {
  const binding = getSessionBinding(conversationKey);
  const seen = binding?.history;
  if (!binding?.foreignSessionId || !seen) return;
  const history = nonSystemMessages(priorMessages);
  const divergence =
    history.length < seen.count ||
    historyFingerprint(history.slice(0, seen.count)).hash !== seen.hash
      ? "host rewrote conversation history"
      : answeredElsewhere(history.slice(seen.count))
        ? "another provider answered turns of this conversation"
        : null;
  if (!divergence) return;
  log.warn(
    `[opencode-claude] ${divergence}; transferring history instead of resuming`,
    {
      conversationKey,
      priorMessages: history.length,
      sentMessages: seen.count,
    },
  );
  deleteBridgesByConversation(conversationKey);
  clearForeignSessionId(conversationKey);
}

/**
 * The turn parked on tool calls this request belongs to. Matched by
 * conversation, else by tool_call_id when the session header is missing or
 * changed.
 */
function findParkedBridge(
  conversationKey: string,
  answeredStep: AnsweredToolStep | null,
): ParkedBridge | null {
  const byConversation = findBridgeByConversation(conversationKey);
  if (byConversation && byConversation.pendingTools.size > 0) return byConversation;
  for (const toolCallId of answeredStep?.results.keys() ?? []) {
    const byTool = findBridgeByPendingTool(toolCallId);
    if (byTool) return byTool;
  }
  return null;
}

/**
 * Resolve the parked calls this request answers. Every call answered: the
 * turn continues. Some still open: OpenCode retried or sent a follow-up
 * before all results arrived — re-emit the open calls instead of starting a
 * parallel Claude turn.
 */
function answerParkedTools(
  bridge: ParkedBridge,
  answeredStep: AnsweredToolStep | null,
  messages: OpenAIMessage[],
  priorMessages: OpenAIMessage[],
): AsyncIterable<unknown> {
  const results = answeredStep?.results ?? new Map<string, McpToolResultContent[]>();
  const resolvable = [...bridge.pendingTools.keys()].filter((id) => results.has(id));
  const lastResolved = resolvable.at(-1);
  // Promoted media rides the last result resolved now: every result of the
  // step reaches Claude in the same tool-result message, and OpenCode does
  // not say which call produced which attachment.
  const media = answeredStep?.media ?? [];
  if (
    lastResolved &&
    media.length > 0 &&
    !resolvable.some((id) => results.get(id)!.some((b) => b.type !== "text"))
  ) {
    results.set(lastResolved, [...results.get(lastResolved)!, ...media]);
    log.info("[opencode-claude] attached promoted tool-result media", {
      toolCallId: lastResolved,
      count: media.length,
    });
  }
  // Deliver queued user messages with the last tool result resolved now,
  // so they reach Claude exactly once.
  const steering = lastResolved ? collectSteeringText(messages) : "";
  for (const toolId of resolvable) {
    const result = results.get(toolId)!;
    bridge.pendingTools
      .get(toolId)!
      .resolve(toolId === lastResolved && steering ? withSteering(result, steering) : result);
    bridge.pendingTools.delete(toolId);
  }
  if (steering) {
    log.info("[opencode-claude] forwarding mid-turn user steering", {
      conversationKey: bridge.conversationKey,
      steeringChars: steering.length,
    });
    // The session has now seen the steering message: later turns must not
    // read it as a turn answered elsewhere.
    setHistoryFingerprint(bridge.conversationKey, historyFingerprint(priorMessages));
  }
  if (bridge.pendingTools.size === 0) {
    log.info("[opencode-claude] resuming parked bridge", {
      conversationKey: bridge.conversationKey,
      resolved: resolvable.length,
    });
    return bridge.resume();
  }
  log.info("[opencode-claude] re-emitting parked tool_calls", {
    conversationKey: bridge.conversationKey,
    pending: bridge.pendingTools.size,
    resolved: resolvable.length,
  });
  const open = [...bridge.pendingTools.values()];
  return (async function* () {
    yield { type: "__park__", tools: open };
  })();
}

function logPromptShape(
  prompt: string | SdkUserPrompt,
  messages: OpenAIMessage[],
): void {
  if (typeof prompt !== "string") {
    log.info("[opencode-claude] multimodal user prompt", {
      blockTypes: Array.isArray(prompt.message.content)
        ? prompt.message.content.map((b) => b.type)
        : ["text"],
    });
    return;
  }
  const content = latestUserMessage(messages)?.content;
  if (!Array.isArray(content)) return;
  log.info("[opencode-claude] user content parts", {
    partTypes: content.map((p) =>
      p && typeof p === "object" && "type" in p ? (p as { type?: unknown }).type : typeof p,
    ),
  });
}

/**
 * Stored Claude session to resume, if its transcript still exists. The
 * claude CLI resumes by looking the session up on disk; a missing transcript
 * (cleanup, different machine, pruned projects dir) would silently start a
 * context-free session, so the stale binding is dropped and the caller
 * transfers the conversation history instead.
 */
function resumableSessionId(conversationKey: string): string | undefined {
  const sessionId = getForeignSessionId(conversationKey);
  if (!sessionId || findClaudeSessionFile(sessionId)) return sessionId;
  log.warn("[opencode-claude] stored Claude session file missing; transferring history", {
    conversationKey,
    foreignSessionId: sessionId,
  });
  clearForeignSessionId(conversationKey);
  return undefined;
}

async function handleChatCompletions(
  req: Request,
  body: ChatCompletionRequest,
): Promise<Response> {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const metaKind = detectMetaRequestKind(messages);
  const isMetaRequest = metaKind !== null;
  const sessionHeader = req.headers.get(SESSION_HEADER);
  const baseConversationKey =
    sessionHeader || conversationKeyFromMessages(messages);
  const conversationKey = requestKeyNamespace(metaKind) + baseConversationKey;
  if (metaKind === "summary") {
    // OpenCode has compacted its history; resuming the old Claude session
    // would restore the pre-compaction context, so the next normal turn must
    // rebuild from the (already compacted) host array instead.
    deleteBridgesByConversation(baseConversationKey);
    clearForeignSessionId(baseConversationKey);
  }
  const selection = selectionFromRequest(req, body);
  const model = resolveClaudeModelId(selection.modelId);
  const responseModel = body.model || model;
  const stream = body.stream !== false;
  const priorMessages = priorMessagesOf(messages);
  if (!isMetaRequest && hostTranscriptWatchEnabled()) {
    dropDivergedSession(conversationKey, priorMessages);
  }

  // Tool results OpenCode returns in this request. Meta requests carry the
  // conversation only as material to transform; they never resume a turn.
  const answeredStep = isMetaRequest ? null : collectAnsweredToolStep(messages);
  const parkedBridge = findParkedBridge(conversationKey, answeredStep);
  if (parkedBridge) {
    const events = answerParkedTools(parkedBridge, answeredStep, messages, priorMessages);
    return turnResponse(req, events, responseModel, parkedBridge, stream);
  }
  if (answeredStep) {
    log.warn(
      "[opencode-claude] tool results arrived with no parked turn; rebuilding the turn with them",
      {
        conversationKey,
        toolResults: answeredStep.results.size,
      },
    );
  }

  const openCodeTools = Array.isArray(body.tools) ? body.tools : [];
  log.info("[opencode-claude] chat completions", {
    conversationKey,
    sessionHeader,
    metaKind,
    toolCount: openCodeTools.length,
    messageCount: messages.length,
    answeredToolResults: answeredStep?.results.size ?? 0,
  });

  const prompt = answeredStep
    ? answeredToolStepPrompt(messages, answeredStep)
    : latestUserPrompt(messages);
  logPromptShape(prompt, messages);
  if (prompt === "" && openCodeTools.length === 0) {
    return errorResponse(400, "invalid_request_error", "No user message found");
  }

  // Confirmed hard subscription limit active? Fail fast with a proper 429 +
  // Retry-After instead of spawning a doomed Agent SDK turn (which would
  // surface as a fake "completed" assistant message and burn time).
  // Placed after input validation so malformed requests still get 400.
  const gate = rateLimitGate();
  if (gate.blocked) {
    log.warn("[opencode-claude] rate-limit gate blocked a turn", {
      conversationKey,
      retryAfterSeconds: gate.retryAfterSeconds,
    });
    return rateLimitResponse(gate.message, gate.retryAfterSeconds, gate.resetsAt);
  }

  // Meta requests are single-shot transformations of the host array, and a
  // turn rebuilt around orphaned tool results cannot continue the session
  // that made the calls.
  const resume =
    isMetaRequest || answeredStep ? undefined : resumableSessionId(conversationKey);

  // No resumable Claude session (first claude-code turn of this chat, model
  // switch mid-conversation, lost store, meta request, orphaned tool
  // results): serialize the prior OpenCode messages into the prompt so Claude
  // sees the whole conversation. Orphaned tool results carry their own step
  // in the prompt, so the history stops before it.
  const transferredHistory = answeredStep
    ? messages.slice(0, answeredStep.assistantIndex)
    : priorMessages;
  const transcript = resume ? "" : buildConversationTranscript(transferredHistory);
  if (transcript) {
    log.info("[opencode-claude] injecting transferred conversation history", {
      conversationKey,
      transcriptChars: transcript.length,
      historyMessages: transferredHistory.length,
    });
  }
  const contextualPrompt = withConversationContext(prompt, transcript);

  const cwd =
    process.env.OPENCODE_CLAUDE_CWD ||
    req.headers.get(DIRECTORY_HEADER)?.trim() ||
    process.cwd();
  const bridgeId = randomUUID();
  // Bind the conversation to the Claude session this turn runs in, together
  // with the host history that session has now seen. SDK events all carry
  // the session id, so it is written once per change, not once per event.
  // Meta requests never resume, so they bind nothing.
  const seenHistory = isMetaRequest ? null : historyFingerprint(priorMessages);
  let boundSessionId: string | null = null;
  const turn = new TurnRunner({
    bridgeId,
    conversationKey,
    onEvent: seenHistory
      ? (event) => {
          const sessionId = extractSessionId(event);
          if (!sessionId || sessionId === boundSessionId) return;
          boundSessionId = sessionId;
          setForeignSessionId(conversationKey, sessionId, {
            modelId: model,
            cwd,
            history: seenHistory,
          });
        }
      : undefined,
  });

  // OpenCode's tools run only through the mcp__opencode__* bridge so every
  // call passes OpenCode's own permission rules. If the bridge cannot be
  // built, refuse the turn: falling back to Claude Code's native Bash/Edit
  // would bypass the permissions the user configured in OpenCode.
  const bridged = !isMetaRequest && openCodeTools.length > 0;
  const mcpServers = bridged
    ? await buildOpenCodeMcpServer(openCodeTools, turn.pendingTools, turn.notifyPark)
    : undefined;
  if (bridged && !mcpServers) {
    log.error("[opencode-claude] OpenCode tool bridge unavailable; refusing turn", {
      conversationKey,
      toolCount: openCodeTools.length,
    });
    throw Object.assign(
      new Error(
        "Could not expose OpenCode's tools to Claude Code (MCP bridge failed to build); the turn was not started. See the opencode-claude log for the cause.",
      ),
      { code: "OPENCODE_TOOL_BRIDGE_UNAVAILABLE", statusCode: 503 },
    );
  }
  const toolNames = bridged ? openCodeToolNames(openCodeTools) : [];

  const handle = await queryStarter({
    prompt:
      metaKind === "title"
        ? titlePrompt(messages)
        : typeof contextualPrompt === "string"
          ? contextualPrompt || " "
          : promptAsStream(contextualPrompt),
    cwd,
    model,
    resume,
    // Meta requests force thinking off; effort "max" is rejected by the API
    // when thinking is disabled, so effort must not be forwarded there.
    effort: isMetaRequest ? undefined : selection.effort,
    env: buildClaudeCodeChildEnv(),
    mcpServers,
    autoCompactEnabled: !isMetaRequest,
    maxTurns: isMetaRequest ? 1 : undefined,
    thinking: isMetaRequest ? { type: "disabled" } : undefined,
    settingSources: isMetaRequest ? [] : undefined,
    skills: isMetaRequest ? [] : undefined,
    // Claude Code's built-in tools are never enabled: bridged turns use the
    // mcp__opencode__* tools, and meta or tool-less agent turns are text-only.
    tools: [],
    toolAliases: bridged ? bridgedToolAliases(toolNames) : undefined,
    allowedTools: bridged ? toolNames.map(bridgedToolName) : undefined,
    // Bridged calls are gated by OpenCode's permission prompts, so Claude-side
    // checks are skipped; anything else is denied without prompting.
    permissionMode: bridged ? "bypassPermissions" : "dontAsk",
    allowDangerouslySkipPermissions: bridged,
    systemPrompt: claudeCodePreset(metaKind, messages, bridged ? toolNames : null),
  });
  turn.attach(handle);

  const bridge: ParkedBridge = {
    id: bridgeId,
    conversationKey,
    handle,
    pendingTools: turn.pendingTools,
    seenAssistantUsageIds: new Set(),
    resume: () => turn.resume(),
  };
  putBridge(bridge);

  const options = { suppressReasoning: isMetaRequest };
  if (!stream) {
    return turnResponse(req, turn.events(), responseModel, bridge, false, options);
  }
  // A turn that dies BEFORE producing any content (bad token, session limit,
  // spawn failure) must surface as a truthful HTTP error — never as a
  // fake-200 stream whose only "assistant text" is the error. Hosts retry
  // fake-200 turns in a loop and each retry re-sends the whole conversation
  // to Anthropic: that doom loop burned ~4% of a weekly quota on 2026-08-11.
  const probe = await closeTurnOnAbort(req.signal, bridgeId, () =>
    probeTurnEvents(turn.events()),
  );
  if (probe.status === "failed") {
    return failureResponse(probe.errorText, conversationKey);
  }
  return streamOpenAIResponse(probe.replay, responseModel, bridge, options);
}


function extractSessionId(event: unknown): string | null {
  if (!event || typeof event !== "object") return null;
  const e = event as Record<string, unknown>;
  if (typeof e.session_id === "string" && e.session_id) return e.session_id;
  if (e.type === "system" && e.subtype === "init") {
    const sid = (e as { session_id?: string }).session_id;
    if (typeof sid === "string") return sid;
  }
  return null;
}


/**
 * Buffer a whole turn and answer with one JSON completion. When the turn
 * died without producing any real content, answer with a truthful HTTP error
 * status instead of a fake-200 whose body is just the error text.
 */
async function collectTurnResponse(
  events: AsyncIterable<unknown>,
  model: string,
  bridge: ParkedBridge,
  options?: { suppressReasoning?: boolean },
): Promise<Response> {
  const suppressReasoning = options?.suppressReasoning === true;
  const completionId = `chatcmpl_${createHash("sha1")
    .update(bridge.id)
    .digest("hex")
    .slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);

  let content = "";
  let reasoning = "";
  const turnUsage = new TurnUsage(bridge.seenAssistantUsageIds);
  let lastErrorNorm: string | null = null;
  let errorText: string | null = null;
  let sawContent = false;
  const toolCalls: ParkedToolCall[] = [];

  const noteError = (text: string) => {
    const norm = normalizeClaudeErrorText(text);
    if (!norm || norm === lastErrorNorm) return;
    lastErrorNorm = norm;
    errorText = text;
    content += `\n\n[claude-code error] ${text}`;
  };

  try {
    for await (const event of events) {
      const mapped = mapSdkEvent(event);
      if (mapped.kind === "park") {
        toolCalls.push(...mapped.tools);
        sawContent = true;
      } else if (mapped.kind === "text") {
        if (mapped.text) sawContent = true;
        content += mapped.text;
      } else if (mapped.kind === "reasoning") {
        if (!suppressReasoning) reasoning += mapped.text;
      } else if (mapped.kind === "usage-delta") {
        turnUsage.assistant(mapped.usage, mapped.messageId);
      } else if (mapped.kind === "usage-stream") {
        turnUsage.stream(mapped.usage);
      } else if (mapped.kind === "usage") {
        turnUsage.result(mapped.usage);
      } else if (mapped.kind === "error") {
        // SDK emits the failure twice (result event + iterator throw) —
        // keep one copy, and keep any usage that came with it.
        if (mapped.usage) turnUsage.result(mapped.usage);
        forgetDeadSession(bridge.conversationKey, mapped.text);
        noteError(mapped.text);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordRateLimitErrorText(message);
    forgetDeadSession(bridge.conversationKey, message);
    noteError(message);
  }

  const usage = turnUsage.resolve();

  // Buffered responses have not committed HTTP headers yet. Even if an agent
  // produced partial work first, preserve the real 429 so OpenCode starts its
  // retry countdown instead of treating the run as a successful answer.
  if (
    errorText &&
    (!sawContent || classifyClaudeFailure(errorText) === "rate_limit")
  ) {
    return failureResponse(errorText, bridge.conversationKey);
  }

  return Response.json({
    id: completionId,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
          ...(reasoning ? { reasoning_content: reasoning } : {}),
          ...(toolCalls.length
            ? {
                tool_calls: toolCalls.map((t) => ({
                  id: t.id,
                  type: "function",
                  function: { name: t.name, arguments: t.arguments },
                })),
              }
            : {}),
        },
        finish_reason: toolCalls.length ? "tool_calls" : "stop",
      },
    ],
    ...(usage ? { usage } : {}),
  });
}

/**
 * Hold the response head until the turn proves it is alive (first real
 * content / tool call / successful result). If it dies first, close the
 * generator (killing the CLI process via TurnRunner.events()'s finally) and report
 * the failure so the caller can answer with a proper HTTP status.
 */
type TurnProbe =
  | { status: "alive"; replay: AsyncIterable<unknown> }
  | { status: "failed"; errorText: string };

function rawProbeKind(event: unknown): "content" | "error" | "neutral" {
  if (!event || typeof event !== "object") return "neutral";
  const e = event as Record<string, unknown>;
  if (e.type === "__park__") return "content";
  if (e.type === "assistant") {
    return assistantErrorText(e) ? "error" : "content";
  }
  if (e.type === "result") return e.is_error ? "error" : "content";
  if (e.type === "stream_event" && e.event && typeof e.event === "object") {
    const ev = e.event as Record<string, unknown>;
    if (
      ev.type === "content_block_delta" &&
      ev.delta &&
      typeof ev.delta === "object"
    ) {
      const delta = ev.delta as Record<string, unknown>;
      if (
        delta.type === "text_delta" &&
        typeof delta.text === "string" &&
        delta.text
      ) {
        return "content";
      }
      if (
        (delta.type === "thinking_delta" ||
          delta.type === "reasoning_delta") &&
        typeof (delta.thinking ?? delta.text) === "string" &&
        String(delta.thinking ?? delta.text)
      ) {
        return "content";
      }
    }
    return "neutral";
  }
  if (e.type === "text_delta" && typeof e.text === "string" && e.text) {
    return "content";
  }
  return "neutral";
}

function rawErrorText(event: unknown): string {
  const e = (event ?? {}) as Record<string, unknown>;
  const assistantText = assistantErrorText(e);
  if (assistantText) return assistantText;
  if (typeof e.result === "string" && e.result) return e.result;
  if (typeof e.error === "string" && e.error) return e.error;
  return "Claude turn failed";
}

async function* chainBuffered(
  buffered: unknown[],
  iterator: AsyncIterator<unknown>,
): AsyncGenerator<unknown, void, unknown> {
  for (const event of buffered) yield event;
  try {
    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      yield next.value;
    }
  } finally {
    try {
      await iterator.return?.(undefined as never);
    } catch {
      // ignore
    }
  }
}

async function probeTurnEvents(
  events: AsyncIterable<unknown>,
): Promise<TurnProbe> {
  const iterator = events[Symbol.asyncIterator]();
  const buffered: unknown[] = [];
  const fail = async (errorText: string): Promise<TurnProbe> => {
    try {
      await iterator.return?.(undefined as never);
    } catch {
      // ignore
    }
    return { status: "failed", errorText };
  };
  try {
    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      const kind = rawProbeKind(next.value);
      if (kind === "error") {
        return fail(rawErrorText(next.value));
      }
      buffered.push(next.value);
      if (kind === "content") {
        return { status: "alive", replay: chainBuffered(buffered, iterator) };
      }
    }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  return fail("Claude Code ended the turn without any output");
}

/**
 * Truthful HTTP error for a turn that died before producing content.
 * Also records hard subscription limits so the fast-fail gate activates and
 * follow-up requests get a cheap 429 without spawning a doomed CLI turn.
 */
function failureResponse(
  errorText: string,
  conversationKey: string,
): Response {
  recordRateLimitErrorText(errorText);
  forgetDeadSession(conversationKey, errorText);
  const kind = classifyClaudeFailure(errorText);
  log.warn("[opencode-claude] turn failed fast", {
    kind,
    conversationKey,
    message: errorText.slice(0, 300),
  });

  if (kind === "rate_limit") {
    const snap = getRateLimitSnapshot();
    const until = snap.limitedUntil ?? snap.resetsAt;
    const retryAfterSeconds =
      until !== undefined
        ? Math.max(1, Math.round((until - Date.now()) / 1000))
        : 600;
    const countdown = formatResetCountdown(retryAfterSeconds * 1000);
    const message = /\blimit resets in\b/i.test(errorText)
      ? errorText
      : `${errorText} · limit resets in ${countdown}${
          snap.resetsAtISO ? ` (${snap.resetsAtISO})` : ""
        }`;
    return rateLimitResponse(message, retryAfterSeconds, snap.resetsAt);
  }

  const hint = failureHintFor(kind);
  return Response.json(
    {
      error: {
        message: hint ? `${errorText} ${hint}` : errorText,
        type: failureTypeFor(kind),
        code: kind === "auth" ? "claude_auth" : "claude_turn_failed",
      },
    },
    { status: failureStatusFor(kind) },
  );
}

function streamOpenAIResponse(
  events: AsyncIterable<unknown>,
  model: string,
  bridge: ParkedBridge,
  options?: { suppressReasoning?: boolean },
): Response {
  const suppressReasoning = options?.suppressReasoning === true;
  const completionId = `chatcmpl_${createHash("sha1")
    .update(bridge.id)
    .digest("hex")
    .slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);

  const encoder = new TextEncoder();
  // Hoisted so cancel() can stop a turn whose client went away: without it
  // an aborted fetch leaves the CLI running and the bridge parked forever.
  let streamClosed = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  const send = (payload: unknown) => {
    if (streamClosed || !controllerRef) return;
    controllerRef.enqueue(
      encoder.encode(`data: ${JSON.stringify(payload)}\n\n`),
    );
  };
  const readable = new ReadableStream({
    async start(controller) {
      controllerRef = controller;

      // Keep the socket busy during thinking pauses. Complements idleTimeout: 0
      // for any hop that still kills silent SSE connections.
      heartbeat = setInterval(() => {
        if (streamClosed) return;
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          streamClosed = true;
          if (heartbeat) clearInterval(heartbeat);
        }
      }, SSE_HEARTBEAT_MS);
      heartbeat.unref?.();

      try {
      send({
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
      });

      let finishReason: string | null = "stop";
      const turnUsage = new TurnUsage(bridge.seenAssistantUsageIds);
      let lastErrorNorm: string | null = null;
      const sendError = (text: string) => {
        const norm = normalizeClaudeErrorText(text);
        if (!norm || norm === lastErrorNorm) return;
        lastErrorNorm = norm;
        if (classifyClaudeFailure(text) === "rate_limit") {
          // The HTTP head is already committed after earlier agent output, so
          // a late 429 is impossible. Send an OpenAI-compatible stream error.
          // Its JSON-string message is understood by OpenCode's stream-error
          // parser as retryable; the first retry then hits our 429 gate with
          // the real Retry-After and switches the UI to the reset countdown.
          send({
            error: {
              message: JSON.stringify({
                type: "error",
                error: {
                  type: "server_error",
                  code: "server_error",
                  message: text,
                },
              }),
              type: "error",
              code: "claude_session_limit",
            },
          });
          return;
        }
        send({
          id: completionId,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [
            {
              index: 0,
              delta: { content: `\n\n[claude-code error] ${text}` },
              finish_reason: null,
            },
          ],
        });
      };

      try {
        for await (const event of events) {
          const mapped = mapSdkEvent(event);
          if (mapped.kind === "park") {
            finishReason = "tool_calls";
            for (let i = 0; i < mapped.tools.length; i++) {
              const tool = mapped.tools[i];
              send({
                id: completionId,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index: i,
                          id: tool.id,
                          type: "function",
                          function: {
                            name: tool.name,
                            arguments: tool.arguments,
                          },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              });
            }
            break;
          }

          if (mapped.kind === "text" && mapped.text) {
            send({
              id: completionId,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [
                {
                  index: 0,
                  delta: { content: mapped.text },
                  finish_reason: null,
                },
              ],
            });
          }

          if (mapped.kind === "reasoning" && mapped.text) {
            if (suppressReasoning) continue;
            send({
              id: completionId,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [
                {
                  index: 0,
                  delta: { reasoning_content: mapped.text },
                  finish_reason: null,
                },
              ],
            });
          }

          if (mapped.kind === "usage-delta") {
            turnUsage.assistant(mapped.usage, mapped.messageId);
          }

          if (mapped.kind === "usage-stream") {
            turnUsage.stream(mapped.usage);
          }

          if (mapped.kind === "usage") {
            turnUsage.result(mapped.usage);
          }

          if (mapped.kind === "error") {
            finishReason = "stop";
            if (mapped.usage) turnUsage.result(mapped.usage);
            forgetDeadSession(bridge.conversationKey, mapped.text);
            log.warn("[opencode-claude] mid-stream turn error", {
              conversationKey: bridge.conversationKey,
              kind: classifyClaudeFailure(mapped.text),
              message: mapped.text.slice(0, 300),
            });
            sendError(mapped.text);
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // A limit/result failure typically arrives here right after the SDK
        // emitted the same text as a result event — dedupe via sendError.
        recordRateLimitErrorText(message);
        forgetDeadSession(bridge.conversationKey, message);
        log.warn("[opencode-claude] stream iterator failed", {
          conversationKey: bridge.conversationKey,
          kind: classifyClaudeFailure(message),
          message: message.slice(0, 300),
        });
        sendError(message);
        finishReason = "stop";
      }

      const usage = turnUsage.resolve();
      if (!streamClosed) {
        send({
          id: completionId,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
          ...(usage ? { usage } : {}),
        });
        try {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        } catch {
          // client already gone
        }
      }
      } finally {
        streamClosed = true;
        if (heartbeat) clearInterval(heartbeat);
      }
    },
    cancel() {
      // The client (OpenCode) aborted the fetch mid-turn. Nothing will
      // consume the rest and nobody can resume a parked tool call, so tear
      // the turn down instead of leaking the CLI process and the bridge.
      streamClosed = true;
      if (heartbeat) clearInterval(heartbeat);
      deleteBridge(bridge.id);
    },
  });

  return new Response(readable, { headers: SSE_HEADERS });
}

type MappedEvent =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "park"; tools: ParkedToolCall[] }
  | { kind: "usage"; usage: OpenAIUsage }
  | { kind: "usage-delta"; usage: OpenAIUsage; messageId: string | null }
  | { kind: "usage-stream"; usage: StreamUsageEvent }
  | { kind: "error"; text: string; usage?: OpenAIUsage | null }
  | { kind: "ignore" };

/** Text carried by Claude's synthetic assistant API-error message. */
function assistantErrorText(event: Record<string, unknown>): string | null {
  if (event.error !== "rate_limit") return null;
  const message = event.message;
  if (!message || typeof message !== "object") return null;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  const text = content
    .filter(
      (block): block is { type: "text"; text: string } =>
        !!block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("\n")
    .trim();
  return text || "Claude session/usage limit reached";
}

/** claude CLI text when `resume` points at a session it cannot load. */
const LOST_SESSION_PATTERN =
  /no conversation found|session\b.*\bnot found|could not (?:find|load|resume).*(?:session|conversation)/i;

/**
 * A resume-target-missing error means the stored foreign session id is dead.
 * Clear it so the next turn transfers history instead of failing forever.
 */
function forgetDeadSession(conversationKey: string, errorText: string): void {
  if (!LOST_SESSION_PATTERN.test(errorText)) return;
  log.warn("[opencode-claude] Claude session lost; clearing stored binding", {
    conversationKey,
  });
  clearForeignSessionId(conversationKey);
}

/**
 * Map Claude Agent SDK events to OpenAI-style deltas.
 *
 * Prefer `stream_event` content_block_delta for text/reasoning. Full
 * `assistant` message payloads repeat the same content after partials and
 * would double-print if both were forwarded.
 */
function mapSdkEvent(event: unknown): MappedEvent {
  if (!event || typeof event !== "object") return { kind: "ignore" };
  const e = event as Record<string, unknown>;

  if (e.type === "__park__" && Array.isArray(e.tools)) {
    return { kind: "park", tools: e.tools as ParkedToolCall[] };
  }

  // Structured subscription limit telemetry from the Agent SDK — record for
  // the /v1/rate-limit counter; surface a note only on meaningful changes.
  // The note decision must use THIS event's own payload (fresh), never
  // merged store history — see maybeRateLimitNote.
  if (e.type === "rate_limit_event") {
    const rawInfo =
      e.rate_limit_info && typeof e.rate_limit_info === "object"
        ? (e.rate_limit_info as Record<string, unknown>)
        : undefined;
    const state = recordRateLimitInfo(rawInfo);
    const note = maybeRateLimitNote(state, rawInfo);
    return note ? { kind: "reasoning", text: note } : { kind: "ignore" };
  }

  // Auto-compact boundary — surface as a short reasoning note for the UI.
  if (e.type === "system" && e.subtype === "compact_boundary") {
    return {
      kind: "reasoning",
      text: formatCompactNote(e.compact_metadata),
    };
  }

  if (e.type === "system" && e.status === "compacting") {
    return { kind: "reasoning", text: "[compact] Compacting context…\n" };
  }

  // stream_event / partial message deltas (authoritative while streaming)
  if (e.type === "stream_event" && e.event && typeof e.event === "object") {
    // message_start / message_delta carry each API call's usage; the delta
    // holds the final output_tokens the assistant event does not have yet.
    const streamUsage = usageFromStreamEvent(event);
    if (streamUsage) return { kind: "usage-stream", usage: streamUsage };
    const ev = e.event as Record<string, unknown>;
    if (ev.type === "content_block_delta" && ev.delta && typeof ev.delta === "object") {
      const delta = ev.delta as Record<string, unknown>;
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        return { kind: "text", text: delta.text };
      }
      if (
        (delta.type === "thinking_delta" || delta.type === "reasoning_delta") &&
        typeof (delta.thinking ?? delta.text) === "string"
      ) {
        return {
          kind: "reasoning",
          text: String(delta.thinking ?? delta.text),
        };
      }
    }
    return { kind: "ignore" };
  }

  // Assistant messages: skip text/thinking replay (already streamed via
  // stream_event). Tool-use blocks are handled by the MCP park path. Usage
  // IS forwarded: each assistant event carries one API call's usage, which
  // is the only usage signal available for parked (tool-call) turns — their
  // `result` event only arrives after the final continuation.
  if (e.type === "assistant") {
    const message =
      e.message && typeof e.message === "object"
        ? (e.message as Record<string, unknown>)
        : null;
    const usage = usageFromAssistantEvent(event);
    // During a multi-step Agent SDK run, Claude can exhaust the subscription
    // on the API call after a tool result. The CLI emits that as a synthetic
    // assistant message (`error: "rate_limit"`) before the terminal result.
    // Record it immediately: the HTTP response is already streaming, so only
    // this event can activate the shared countdown/gate in time.
    const errorText = assistantErrorText(e);
    if (errorText) {
      const limited = recordRateLimitErrorText(errorText);
      let note = errorText;
      const until = limited?.limitedUntil ?? limited?.resetsAt;
      if (until !== undefined) {
        const wait = formatResetCountdown(Math.max(0, until - Date.now()));
        note = `${errorText} · limit resets in ${wait}${
          limited?.resetsAt
            ? ` (${new Date(limited.resetsAt).toISOString()})`
            : ""
        }`;
      }
      return { kind: "error", text: note, usage };
    }
    if (usage) {
      return {
        kind: "usage-delta",
        usage,
        messageId: typeof message?.id === "string" ? message.id : null,
      };
    }
    return { kind: "ignore" };
  }

  if (e.type === "result") {
    // result.usage is the per-turn snapshot; modelUsage is cumulative for
    // the whole query and only donates the per-model breakdown.
    const turnUsage = usageFromSdkTurnResult(event);
    const accountingUsage = usageFromSdkResult(event);
    const usage = turnUsage
      ? {
          ...turnUsage,
          ...(accountingUsage?.model_usage !== undefined
            ? { model_usage: accountingUsage.model_usage }
            : {}),
        }
      : accountingUsage;
    if (e.is_error) {
      const text =
        typeof e.result === "string"
          ? e.result
          : typeof e.error === "string"
            ? e.error
            : "Claude turn failed";
      // Hard subscription limit? Record it so the gate + counter activate.
      const limited = recordRateLimitErrorText(text);
      let note = text;
      if (limited?.limited) {
        const until = limited.limitedUntil ?? limited.resetsAt;
        if (until !== undefined) {
          const wait = formatResetCountdown(Math.max(0, until - Date.now()));
          note = `${text} · limit resets in ${wait}${
            limited.resetsAt
              ? ` (${new Date(limited.resetsAt).toISOString()})`
              : ""
          }`;
        }
      }
      return { kind: "error", text: note, usage };
    }
    if (usage) return { kind: "usage", usage };
    return { kind: "ignore" };
  }

  // Fallback for SDK builds that emit bare text deltas without stream_event
  if (typeof e.text === "string" && e.type === "text_delta") {
    return { kind: "text", text: e.text };
  }

  return { kind: "ignore" };
}
