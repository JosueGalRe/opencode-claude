/**
 * Thin wrapper around @anthropic-ai/claude-agent-sdk query()/close().
 * Import failure is surfaced as unavailable — detect must not report ready.
 */
import { buildClaudeCodeChildEnv } from "./auth-env.js";
import { isClaudeEffort, type ClaudeEffort } from "./constants.js";
import {
  assertClaudeWorkingDirectory,
  resolveClaudeCodeExecutable,
} from "./executable-path.js";
import { log } from "./log.js";

type SdkModule = typeof import("@anthropic-ai/claude-agent-sdk");

let sdkModulePromise: Promise<SdkModule> | null = null;
let sdkLoadError: Error | null = null;
let sdkModule: SdkModule | null = null;

const ALLOWED_PERMISSION_MODES = new Set([
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
  "dontAsk",
]);

const trimmedString = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

function nonEmptyRecord(
  value: unknown,
): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return Object.keys(value).length > 0 ? (value as Record<string, unknown>) : null;
}

export async function loadClaudeAgentSdk(): Promise<SdkModule> {
  if (sdkModule) return sdkModule;
  if (sdkLoadError) throw sdkLoadError;
  if (!sdkModulePromise) {
    sdkModulePromise = import("@anthropic-ai/claude-agent-sdk")
      .then((mod) => {
        sdkModule = mod;
        return mod;
      })
      .catch((error) => {
        sdkLoadError =
          error instanceof Error
            ? error
            : new Error(
                String(
                  (error as { message?: string })?.message ||
                    error ||
                    "Failed to load Claude Agent SDK",
                ),
              );
        sdkModulePromise = null;
        throw sdkLoadError;
      });
  }
  return sdkModulePromise;
}

export function resetClaudeAgentSdkCache(): void {
  sdkModule = null;
  sdkModulePromise = null;
  sdkLoadError = null;
}

export async function probeClaudeAgentSdk(): Promise<{
  available: boolean;
  error?: string;
}> {
  try {
    await loadClaudeAgentSdk();
    return { available: true };
  } catch (error) {
    return {
      available: false,
      error:
        error instanceof Error ? error.message : "Claude Agent SDK unavailable",
    };
  }
}

export type ClaudeQueryHandle = {
  stream: AsyncIterable<unknown>;
  /** End the query and its CLI subprocess (SDK `Query.close()`); idempotent. */
  close: () => void;
  interrupt?: () => Promise<void>;
  stop?: (graceMs?: number) => Promise<void>;
  onEvent?: (listener: (event: unknown) => void) => void;
};

export type StoppableClaudeQueryHandle = ClaudeQueryHandle & {
  stop: (graceMs?: number) => Promise<void>;
  onEvent: (listener: (event: unknown) => void) => void;
};

export function stopGraceMs(): number {
  const raw = Number(process.env.OPENCODE_CLAUDE_STOP_GRACE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 2_000;
}

/** Interrupt, observe the CLI's interruption entries, then close on result or timeout. */
export function withGracefulStop(handle: ClaudeQueryHandle): StoppableClaudeQueryHandle {
  if (handle.stop && handle.onEvent) return { ...handle, stop: handle.stop, onEvent: handle.onEvent };
  const inner = handle.stream[Symbol.asyncIterator]();
  const listeners: Array<(event: unknown) => void> = [];
  const completed = Promise.withResolvers<void>();
  const closedSignal = Promise.withResolvers<IteratorResult<unknown>>();
  let ended = false;
  let sawResult = false;
  let closed = false;
  let pending: Promise<IteratorResult<unknown>> | null = null;
  const tap: AsyncIterableIterator<unknown> = {
    next() {
      if (closed || ended) return Promise.resolve({ done: true, value: undefined });
      // A parked/running consumer may already have next() in flight. Share
      // that read with stop(), rather than issuing concurrent SDK reads.
      pending ??= Promise.race([inner.next(), closedSignal.promise]).then((next) => {
        if (closed) return { done: true, value: undefined };
        if (next.done) ended = true;
        else {
          const event = next.value;
          if (event && typeof event === "object" && "type" in event && event.type === "result") {
            sawResult = true;
            completed.resolve();
          }
          for (const listener of listeners) listener(event);
        }
        return next;
      }).catch((error: unknown) => {
        ended = true;
        throw error;
      }).finally(() => { pending = null; });
      return pending;
    },
    [Symbol.asyncIterator]() { return tap; },
  };
  const close = () => {
    if (closed) return;
    closed = true;
    closedSignal.resolve({ done: true, value: undefined });
    handle.close();
  };
  let stopping: Promise<void> | null = null;
  const stop = (graceMs = stopGraceMs()) => {
    stopping ??= (async () => {
      if (!closed && !ended && !sawResult && handle.interrupt && graceMs > 0) {
        const interrupt = handle.interrupt;
        const settle = (async () => {
          try {
            await interrupt();
            while (!closed && !ended && !sawResult) {
              if ((await tap.next()).done) break;
            }
          } catch (error) {
            // The SDK rejects when the process is already gone; close still runs.
            log.info("[opencode-claude] stopped query could not settle", error instanceof Error ? error.message : error);
          }
        })();
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([settle, completed.promise, new Promise<void>((resolve) => {
          timer = setTimeout(resolve, graceMs);
          timer.unref?.();
        })]);
        if (timer) clearTimeout(timer);
      }
      close();
    })();
    return stopping;
  };
  return { ...handle, stream: tap, close, stop, onEvent: (listener) => { listeners.push(listener); } };
}

export type StartClaudeQueryParams = {
  prompt: string | AsyncIterable<unknown>;
  cwd: string;
  model?: string;
  resume?: string;
  /** Resume this main-chain entry, not the latest branch in the file. */
  resumeSessionAt?: string;
  permissionMode?: string;
  effort?: ClaudeEffort | string;
  systemPrompt?:
    | string
    | { type: "preset"; preset: "claude_code"; append?: string };
  canUseTool?: (
    toolName: string,
    input: Record<string, unknown>,
    options: object,
  ) => Promise<object | null>;
  env?: Record<string, string | undefined>;
  includePartialMessages?: boolean;
  mcpServers?: Record<string, unknown>;
  agents?: Record<string, object>;
  agent?: string;
  allowedTools?: string[];
  /** Disable Claude built-in tools so OpenCode owns tool execution. */
  tools?: string[] | { type: string; [key: string]: unknown };
  /** Redirect built-in tool names to OpenCode MCP tools. */
  toolAliases?: Record<string, string>;
  disallowedTools?: string[];
  skills?: string[] | "all";
  settingSources?: Array<"user" | "project" | "local">;
  pathToClaudeCodeExecutable?: string;
  /** Required when permissionMode is bypassPermissions. */
  allowDangerouslySkipPermissions?: boolean;
  /**
   * `false` turns Claude Code auto-compact off for this query (passed as the
   * `autoCompactEnabled` flag setting); otherwise the user's Claude Code
   * setting applies (default on).
   */
  autoCompactEnabled?: boolean;
  /** Stop utility queries such as title generation after one model turn. */
  maxTurns?: number;
  /** `false` keeps one-shot utility turns out of `claude --resume` history. */
  persistSession?: boolean;
  /** Thinking config; defaults to adaptive when effort is set. */
  thinking?:
    | { type: "adaptive"; display?: "summarized" | "omitted" }
    | { type: "enabled"; budgetTokens: number; display?: "summarized" | "omitted" }
    | { type: "disabled" };
  queryImpl?: (mod: SdkModule) => unknown;
};

export async function startClaudeQuery(
  params: StartClaudeQueryParams,
): Promise<ClaudeQueryHandle> {
  const sdk = await loadClaudeAgentSdk();
  const queryFn =
    typeof params.queryImpl === "function"
      ? params.queryImpl(sdk)
      : (sdk as { query?: unknown }).query;

  if (typeof queryFn !== "function") {
    const error = new Error("Claude Agent SDK query() is unavailable") as Error & {
      code?: string;
      statusCode?: number;
    };
    error.code = "CLAUDE_SDK_UNAVAILABLE";
    error.statusCode = 503;
    throw error;
  }

  const env = buildClaudeCodeChildEnv(params.env || process.env);
  const cwd = assertClaudeWorkingDirectory(params.cwd);
  const pathToClaudeCodeExecutable =
    trimmedString(params.pathToClaudeCodeExecutable) ||
    (await resolveClaudeCodeExecutable({ env })) ||
    undefined;

  const options: Record<string, unknown> = {
    cwd,
    env,
    includePartialMessages: params.includePartialMessages !== false,
    settingSources: Array.isArray(params.settingSources)
      ? params.settingSources
      : ["user", "project", "local"],
  };

  if (pathToClaudeCodeExecutable) {
    options.pathToClaudeCodeExecutable = pathToClaudeCodeExecutable;
  }

  const model = trimmedString(params.model);
  if (model) options.model = model;

  const resume = trimmedString(params.resume);
  if (resume) options.resume = resume;
  const resumeSessionAt = trimmedString(params.resumeSessionAt);
  if (resume && resumeSessionAt) options.resumeSessionAt = resumeSessionAt;

  const permissionMode = trimmedString(params.permissionMode);
  if (ALLOWED_PERMISSION_MODES.has(permissionMode)) {
    options.permissionMode = permissionMode;
  }
  if (
    params.allowDangerouslySkipPermissions === true &&
    permissionMode === "bypassPermissions"
  ) {
    options.allowDangerouslySkipPermissions = true;
  }

  const effort = trimmedString(params.effort);
  if (isClaudeEffort(effort)) options.effort = effort;

  if (params.thinking) {
    options.thinking = params.thinking.type === "disabled"
      ? params.thinking
      : { ...params.thinking, display: "summarized" };
  } else if (isClaudeEffort(effort)) {
    // Effort guides adaptive thinking depth on models that support it.
    options.thinking = { type: "adaptive", display: "summarized" };
  }

  // Only the servers passed in `mcpServers` (the OpenCode tool bridge): the
  // user's Claude Code MCP servers and claude.ai connectors would add their
  // tools to every turn, outside OpenCode's permission rules.
  options.strictMcpConfig = true;
  options.settings = {
    disableClaudeAiConnectors: true,
    ...(params.autoCompactEnabled === false ? { autoCompactEnabled: false } : {}),
  };

  if (params.persistSession === false) options.persistSession = false;

  if (Number.isInteger(params.maxTurns) && Number(params.maxTurns) > 0) {
    options.maxTurns = params.maxTurns;
  }

  if (typeof params.canUseTool === "function") {
    options.canUseTool = params.canUseTool;
  }

  const customSystemPrompt = trimmedString(params.systemPrompt);
  const presetSystemPrompt =
    typeof params.systemPrompt === "string"
      ? null
      : nonEmptyRecord(params.systemPrompt);
  if (customSystemPrompt) {
    options.systemPrompt = customSystemPrompt;
  } else if (
    presetSystemPrompt?.type === "preset" &&
    presetSystemPrompt.preset === "claude_code"
  ) {
    const systemPrompt: {
      type: "preset";
      preset: "claude_code";
      append?: string;
    } = { type: "preset", preset: "claude_code" };
    const append = trimmedString(presetSystemPrompt.append);
    if (append) systemPrompt.append = append;
    options.systemPrompt = systemPrompt;
  } else {
    options.systemPrompt = { type: "preset", preset: "claude_code" };
  }

  if (nonEmptyRecord(params.mcpServers)) options.mcpServers = params.mcpServers;
  if (nonEmptyRecord(params.agents)) options.agents = params.agents;

  const mainAgent = trimmedString(params.agent);
  if (mainAgent) options.agent = mainAgent;

  if (Array.isArray(params.allowedTools) && params.allowedTools.length > 0) {
    options.allowedTools = params.allowedTools.filter(
      (tool) => typeof tool === "string" && tool.trim(),
    );
  }

  if (Array.isArray(params.disallowedTools) && params.disallowedTools.length > 0) {
    options.disallowedTools = params.disallowedTools.filter(
      (tool) => typeof tool === "string" && tool.trim(),
    );
  }

  if (params.tools !== undefined) {
    options.tools = params.tools;
  }

  if (nonEmptyRecord(params.toolAliases)) {
    options.toolAliases = params.toolAliases;
  }

  if (params.skills === "all" || Array.isArray(params.skills)) {
    options.skills = params.skills;
  } else if (params.skills === undefined) {
    options.skills = "all";
  }

  log.info("[opencode-claude] starting Claude Agent SDK query", {
    model: options.model,
    effort: options.effort,
    resume: Boolean(resume),
    cwd,
  });

  let result: any;
  try {
    result = (queryFn as (input: { prompt: unknown; options: unknown }) => unknown)({
      prompt: params.prompt,
      options,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/spawn.*ENOTDIR/i.test(message)) {
      const wrapped = new Error(
        "Claude Code executable path is not spawnable (ENOTDIR).",
      ) as Error & { code?: string; statusCode?: number; cause?: unknown };
      wrapped.code = "CLAUDE_SPAWN_ENOTDIR";
      wrapped.statusCode = 503;
      wrapped.cause = error;
      throw wrapped;
    }
    throw error;
  }

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      result?.close?.();
    } catch {
      // already torn down
    }
  };

  return withGracefulStop({
    stream: result as AsyncIterable<unknown>,
    interrupt: async () => { await result?.interrupt?.(); },
    close,
  });
}

/** Idle SDK query: reads CLI model metadata without sending a prompt or model call. */
export async function listClaudeSupportedModels(
  timeoutMs = 20_000,
): Promise<import("@anthropic-ai/claude-agent-sdk").ModelInfo[] | null> {
  const sdk = await loadClaudeAgentSdk();
  let release: () => void = () => {};
  const idle = (async function* () {
    await new Promise<void>((resolve) => { release = resolve; });
  })();
  const env = buildClaudeCodeChildEnv(process.env);
  const pathToClaudeCodeExecutable = await resolveClaudeCodeExecutable({ env });
  const query = sdk.query({
    prompt: idle,
    options: {
      env,
      persistSession: false,
      settingSources: [],
      strictMcpConfig: true,
      settings: { disableClaudeAiConnectors: true },
      ...(pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable } : {}),
    },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      query.supportedModels(),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    release();
    query.close();
  }
}
