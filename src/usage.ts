/**
 * Convert Claude Agent SDK result usage into OpenAI-compatible usage objects.
 *
 * Prefer `modelUsage` for totals (includes compact / auxiliary pipeline calls).
 * Fall back to per-turn `usage` (main agent loop only).
 */

export type OpenAIUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
  };
  completion_tokens_details?: {
    reasoning_tokens?: number;
  };
  /** Estimated USD from the Agent SDK (not a billing statement). */
  cost_usd?: number;
  /** Per-model breakdown when the SDK provides modelUsage. */
  model_usage?: Record<
    string,
    {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens: number;
      cache_creation_input_tokens: number;
      cost_usd: number;
      context_window?: number;
    }
  >;
  aggregate_usage?: OpenAIUsage;
};

export type AssistantUsageState = {
  readonly aggregate: OpenAIUsage | null;
  readonly latest: OpenAIUsage | null;
};

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function fromAnthropicUsage(usage: Record<string, unknown>): OpenAIUsage {
  const input = asNumber(usage.input_tokens);
  const completion = asNumber(usage.output_tokens);
  const cached = asNumber(usage.cache_read_input_tokens);
  const cacheWrite = asNumber(usage.cache_creation_input_tokens);
  // OpenAI contract: prompt_tokens is the INCLUSIVE prompt total and
  // prompt_tokens_details.cached_tokens is a subset of it. Anthropic reports
  // input_tokens excluding cached tokens, so sum them back in — consumers
  // (OpenCode) derive the non-cached count by subtracting the details.
  const prompt = input + cached + cacheWrite;
  const details: NonNullable<OpenAIUsage["prompt_tokens_details"]> = {};
  if (cached > 0) details.cached_tokens = cached;
  if (cacheWrite > 0) details.cache_write_tokens = cacheWrite;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    ...(Object.keys(details).length ? { prompt_tokens_details: details } : {}),
  };
}

function fromModelUsage(
  modelUsage: Record<string, unknown>,
): OpenAIUsage | null {
  let prompt = 0;
  let completion = 0;
  let cached = 0;
  let cacheWrite = 0;
  let cost = 0;
  const breakdown: NonNullable<OpenAIUsage["model_usage"]> = {};
  let any = false;

  for (const [modelId, raw] of Object.entries(modelUsage)) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    any = true;
    const input = asNumber(entry.inputTokens);
    const output = asNumber(entry.outputTokens);
    const cacheRead = asNumber(entry.cacheReadInputTokens);
    const cacheCreate = asNumber(entry.cacheCreationInputTokens);
    const costUSD = asNumber(entry.costUSD);
    prompt += input + cacheRead + cacheCreate;
    completion += output;
    cached += cacheRead;
    cacheWrite += cacheCreate;
    cost += costUSD;
    breakdown[modelId] = {
      input_tokens: input,
      output_tokens: output,
      cache_read_input_tokens: cacheRead,
      cache_creation_input_tokens: cacheCreate,
      cost_usd: costUSD,
      ...(typeof entry.contextWindow === "number"
        ? { context_window: entry.contextWindow }
        : {}),
    };
  }

  if (!any) return null;
  const details: NonNullable<OpenAIUsage["prompt_tokens_details"]> = {};
  if (cached > 0) details.cached_tokens = cached;
  if (cacheWrite > 0) details.cache_write_tokens = cacheWrite;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    ...(Object.keys(details).length ? { prompt_tokens_details: details } : {}),
    ...(cost > 0 ? { cost_usd: cost } : {}),
    ...(Object.keys(breakdown).length ? { model_usage: breakdown } : {}),
  };
}

/**
 * Extract OpenAI-compatible usage from an Agent SDK `result` event.
 */
export function usageFromSdkResult(event: unknown): OpenAIUsage | null {
  if (!event || typeof event !== "object") return null;
  const e = event as Record<string, unknown>;
  if (e.type !== "result") return null;

  if (e.modelUsage && typeof e.modelUsage === "object") {
    const fromModels = fromModelUsage(
      e.modelUsage as Record<string, unknown>,
    );
    if (fromModels) {
      if (
        typeof e.total_cost_usd === "number" &&
        Number.isFinite(e.total_cost_usd) &&
        fromModels.cost_usd === undefined
      ) {
        fromModels.cost_usd = e.total_cost_usd;
      }
      return fromModels;
    }
  }

  if (e.usage && typeof e.usage === "object") {
    const usage = fromAnthropicUsage(e.usage as Record<string, unknown>);
    if (
      typeof e.total_cost_usd === "number" &&
      Number.isFinite(e.total_cost_usd)
    ) {
      usage.cost_usd = e.total_cost_usd;
    }
    return usage;
  }

  return null;
}

/** Extract the per-turn usage snapshot from an Agent SDK `result` event. */
export function usageFromSdkTurnResult(event: unknown): OpenAIUsage | null {
  if (!event || typeof event !== "object") return null;
  const e = event as Record<string, unknown>;
  if (e.type !== "result") return null;
  if (!e.usage || typeof e.usage !== "object") return null;

  const usage = fromAnthropicUsage(e.usage as Record<string, unknown>);
  if (
    typeof e.total_cost_usd === "number" &&
    Number.isFinite(e.total_cost_usd)
  ) {
    usage.cost_usd = e.total_cost_usd;
  }
  return usage;
}

/**
 * Extract per-API-call usage from an Agent SDK `assistant` event
 * (`message.usage`). Each assistant event carries the usage of exactly one
 * Anthropic API call — including parked (tool-call) turns, where no `result`
 * event exists yet because the query is still alive. The CLI emits it with
 * the `message_start` snapshot, so `output_tokens` is provisional until the
 * call's `message_delta` (see {@link TurnUsage}).
 */
export function usageFromAssistantEvent(event: unknown): OpenAIUsage | null {
  if (!event || typeof event !== "object") return null;
  const e = event as Record<string, unknown>;
  if (e.type !== "assistant") return null;
  const message = e.message;
  if (!message || typeof message !== "object") return null;
  const usage = (message as Record<string, unknown>).usage;
  if (!usage || typeof usage !== "object") return null;
  return fromAnthropicUsage(usage as Record<string, unknown>);
}

/**
 * Accumulate per-call usage deltas into a per-response total.
 */
export function addOpenAIUsage(
  acc: OpenAIUsage | null,
  delta: OpenAIUsage,
): OpenAIUsage {
  if (!acc) return { ...delta };
  const cached =
    (acc.prompt_tokens_details?.cached_tokens ?? 0) +
    (delta.prompt_tokens_details?.cached_tokens ?? 0);
  const cacheWrite =
    (acc.prompt_tokens_details?.cache_write_tokens ?? 0) +
    (delta.prompt_tokens_details?.cache_write_tokens ?? 0);
  const reasoning =
    (acc.completion_tokens_details?.reasoning_tokens ?? 0) +
    (delta.completion_tokens_details?.reasoning_tokens ?? 0);
  const promptDetails: NonNullable<OpenAIUsage["prompt_tokens_details"]> = {};
  if (cached > 0) promptDetails.cached_tokens = cached;
  if (cacheWrite > 0) promptDetails.cache_write_tokens = cacheWrite;
  return {
    prompt_tokens: acc.prompt_tokens + delta.prompt_tokens,
    completion_tokens: acc.completion_tokens + delta.completion_tokens,
    total_tokens: acc.total_tokens + delta.total_tokens,
    ...(Object.keys(promptDetails).length
      ? { prompt_tokens_details: promptDetails }
      : {}),
    ...(reasoning > 0
      ? { completion_tokens_details: { reasoning_tokens: reasoning } }
      : {}),
  };
}

/** Count a replayed SDK assistant message only once across tool continuations. */
export function addUniqueAssistantUsageState(
  state: AssistantUsageState,
  delta: OpenAIUsage,
  messageId: string | null,
  seen: Set<string>,
): AssistantUsageState {
  if (messageId) {
    if (seen.has(messageId)) return state;
    seen.add(messageId);
  }
  return {
    aggregate: addOpenAIUsage(state.aggregate, delta),
    latest: delta,
  };
}

type AnthropicUsage = Record<string, unknown>;

/** Usage carried by a partial-message `stream_event` (message_start/_delta). */
export type StreamUsageEvent =
  | {
      readonly phase: "start";
      /** Stream the message belongs to (`parent_tool_use_id`; "" = main). */
      readonly scope: string;
      readonly messageId: string | null;
      readonly usage: AnthropicUsage;
    }
  | {
      readonly phase: "delta";
      readonly scope: string;
      readonly usage: AnthropicUsage;
    };

/**
 * Extract usage from an Agent SDK `stream_event`. `message_start` opens an
 * API call with its initial usage; `message_delta` carries that call's final
 * cumulative counts (the only place the real `output_tokens` appear before
 * the terminal `result`).
 */
export function usageFromStreamEvent(event: unknown): StreamUsageEvent | null {
  if (!event || typeof event !== "object") return null;
  const e = event as Record<string, unknown>;
  if (e.type !== "stream_event" || !e.event || typeof e.event !== "object") {
    return null;
  }
  const ev = e.event as Record<string, unknown>;
  const scope =
    typeof e.parent_tool_use_id === "string" ? e.parent_tool_use_id : "";
  if (ev.type === "message_start") {
    const message =
      ev.message && typeof ev.message === "object"
        ? (ev.message as Record<string, unknown>)
        : null;
    if (!message?.usage || typeof message.usage !== "object") return null;
    return {
      phase: "start",
      scope,
      messageId: typeof message.id === "string" ? message.id : null,
      usage: message.usage as AnthropicUsage,
    };
  }
  if (ev.type === "message_delta" && ev.usage && typeof ev.usage === "object") {
    return { phase: "delta", scope, usage: ev.usage as AnthropicUsage };
  }
  return null;
}

/**
 * Per-response usage accounting. Assistant events and `message_start` give
 * each API call's usage with provisional `output_tokens`; the call's
 * `message_delta` (which follows its `message_start` in the same scope)
 * replaces them with the final cumulative counts. `seen` is shared across a
 * bridge's continuations so a call is counted in exactly one response.
 */
export class TurnUsage {
  #state: AssistantUsageState = { aggregate: null, latest: null };
  #result: OpenAIUsage | null = null;
  /** This response's calls, in first-seen order (id null = unidentified). */
  readonly #calls: Array<{ id: string | null; usage: OpenAIUsage }> = [];
  /** Open message per stream scope, awaiting its message_delta. */
  readonly #open = new Map<
    string,
    { id: string | null; usage: AnthropicUsage }
  >();

  readonly #seen: Set<string>;

  constructor(seen: Set<string>) {
    this.#seen = seen;
  }

  /** Usage from an `assistant` event (provisional output_tokens). */
  assistant(usage: OpenAIUsage, messageId: string | null): void {
    const next = addUniqueAssistantUsageState(
      this.#state,
      usage,
      messageId,
      this.#seen,
    );
    if (next === this.#state) return;
    this.#state = next;
    this.#calls.push({ id: messageId, usage });
  }

  stream(event: StreamUsageEvent): void {
    if (event.phase === "start") {
      this.#open.set(event.scope, { id: event.messageId, usage: event.usage });
      return;
    }
    const open = this.#open.get(event.scope);
    if (!open) return;
    this.#open.delete(event.scope);
    // message_delta counts are cumulative; null fields keep the start value.
    const merged: AnthropicUsage = { ...open.usage };
    for (const [key, value] of Object.entries(event.usage)) {
      if (typeof value === "number" && Number.isFinite(value)) {
        merged[key] = value;
      }
    }
    const final = fromAnthropicUsage(merged);
    const index =
      open.id === null ? -1 : this.#calls.findIndex((c) => c.id === open.id);
    if (index === -1) {
      // No assistant event for this call yet: count it now. A call already
      // reported by an earlier response of this bridge stays there.
      this.assistant(final, open.id);
      return;
    }
    this.#calls[index] = { id: open.id, usage: final };
    let aggregate: OpenAIUsage | null = null;
    for (const call of this.#calls) {
      aggregate = addOpenAIUsage(aggregate, call.usage);
    }
    this.#state = {
      aggregate,
      latest: this.#calls[this.#calls.length - 1]!.usage,
    };
  }

  /** Usage from the terminal `result` event (fallback / metadata donor). */
  result(usage: OpenAIUsage): void {
    this.#result = usage;
  }

  resolve(): OpenAIUsage | null {
    return resolveOpenCodeUsage(this.#state, this.#result);
  }
}

/**
 * OpenCode reads `usage` as the CURRENT context size (for compaction
 * scheduling), so the per-response report must be the latest API call's
 * totals — not the sum of the turn's calls (each call re-sends the whole
 * context, so summing inflates it), and not the SDK result's cumulative
 * snapshot (which includes prior turns of a continued query). The sum is
 * preserved as `aggregate_usage`; the result snapshot is a fallback for
 * turns with no assistant events and a donor for cost/model metadata.
 */
export function resolveOpenCodeUsage(
  state: AssistantUsageState,
  result: OpenAIUsage | null,
): OpenAIUsage | null {
  const current = state.latest ?? state.aggregate ?? result;
  if (!current) return null;
  const aggregate = state.aggregate;
  const aggregateDiffers =
    aggregate !== null &&
    state.latest !== null &&
    (aggregate.prompt_tokens !== state.latest.prompt_tokens ||
      aggregate.completion_tokens !== state.latest.completion_tokens ||
      aggregate.total_tokens !== state.latest.total_tokens ||
      aggregate.prompt_tokens_details?.cached_tokens !==
        state.latest.prompt_tokens_details?.cached_tokens ||
      aggregate.prompt_tokens_details?.cache_write_tokens !==
        state.latest.prompt_tokens_details?.cache_write_tokens);
  return {
    ...current,
    ...(current.cost_usd === undefined && result?.cost_usd !== undefined
      ? { cost_usd: result.cost_usd }
      : {}),
    ...(current.model_usage === undefined && result?.model_usage !== undefined
      ? { model_usage: result.model_usage }
      : {}),
    ...(aggregateDiffers
      ? { aggregate_usage: aggregate }
      : {}),
  };
}

export function formatCompactNote(meta: unknown): string {
  if (!meta || typeof meta !== "object") {
    return "[compact] Conversation compacted.\n";
  }
  const m = meta as Record<string, unknown>;
  const trigger = typeof m.trigger === "string" ? m.trigger : "auto";
  const pre = asNumber(m.pre_tokens);
  const post =
    typeof m.post_tokens === "number" && Number.isFinite(m.post_tokens)
      ? m.post_tokens
      : null;
  const duration =
    typeof m.duration_ms === "number" && Number.isFinite(m.duration_ms)
      ? m.duration_ms
      : null;
  const parts = [`[compact] Conversation compacted (${trigger})`];
  if (pre > 0) {
    parts.push(
      post !== null
        ? `tokens ${pre} → ${post}`
        : `pre_tokens ${pre}`,
    );
  }
  if (duration !== null) parts.push(`${duration}ms`);
  return `${parts.join("; ")}.\n`;
}
