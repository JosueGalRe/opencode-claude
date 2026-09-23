/**
 * One Claude Agent SDK turn and its park/resume state machine.
 *
 * Bridged OpenCode tools never run inside Claude Code: the MCP handler
 * registers the call in `pendingTools` and calls `notifyPark()`. The runner
 * then holds until the assistant message closes (so every call of that
 * message reaches OpenCode in one response), yields one `__park__` event and
 * returns — the CLI child stays alive, blocked on the tool results. The next
 * request resolves the calls and continues the same SDK stream via
 * `resume()`.
 */
import { deleteBridge, type ParkedToolCall } from "./bridge-pool.js";
import { log } from "./log.js";
import type { ClaudeQueryHandle } from "./query.js";

/**
 * A parked turn waits for the assistant message to close so that every tool
 * call of that message reaches OpenCode in one response (see
 * PARALLEL_SAFE_TOOLS). This much silence from the CLI ends the wait.
 */
const PARK_QUIET_MS = 3_000;

const STRUCTURED_OUTPUT_TOOL = "StructuredOutput";

/**
 * OpenCode treats a StructuredOutput call as the end of the request and never
 * sends a tool result back, so such a park is closed after this grace period.
 */
function structuredOutputReapMs(): number {
  const raw = Number(process.env.OPENCODE_CLAUDE_STRUCTURED_OUTPUT_REAP_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 60_000;
}

/**
 * Max time a turn stays parked on regular tools. Each parked turn holds a
 * live claude CLI child; a conversation that is abandoned mid-tool-call would
 * otherwise keep it until the proxy stops. Results that arrive later still
 * work: the turn is rebuilt around them (answeredToolStepPrompt). `0`
 * disables the limit.
 */
function parkedTurnTtlMs(): number | null {
  const raw = Number(process.env.OPENCODE_CLAUDE_PARKED_TURN_TTL_MS);
  if (!Number.isFinite(raw) || raw < 0) return 3_600_000;
  return raw === 0 ? null : raw;
}

/**
 * Max silence from the Claude Agent SDK before the turn is declared dead.
 * Read per request so tests and operators can tune it without a rebuild.
 * A silent stream holds the SSE response open forever (idleTimeout is 0 by
 * design), which wedges the OpenCode session as "busy" until the host's
 * supervisor force-restarts the whole server — the 2026-08-18 hang.
 */
function turnStallMs(): number {
  const raw = Number(process.env.OPENCODE_CLAUDE_TURN_STALL_MS);
  return Number.isFinite(raw) && raw >= 1_000 ? raw : 600_000;
}

function stallError(ms: number): Error {
  const span =
    ms < 90_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60000)}m`;
  return new Error(
    `Claude Code produced no output for ${span} — the turn was killed. Retry the message.`,
  );
}

export type TurnRunnerOptions = {
  bridgeId: string;
  conversationKey: string;
  /** Sees every SDK event before it is yielded. */
  onEvent?: (event: unknown) => void;
};

type Raced =
  | { kind: "event"; value: IteratorResult<unknown> }
  | { kind: "park" }
  | { kind: "quiet" };

export class TurnRunner {
  /** Bridged calls waiting for OpenCode, by tool_call_id. */
  readonly pendingTools = new Map<string, ParkedToolCall>();

  private handle: ClaudeQueryHandle | null = null;
  private iterator: AsyncIterator<unknown> | null = null;
  private parked = false;
  private parkWaiters: Array<() => void> = [];
  /**
   * The assistant message is still streaming: sibling tool calls may follow
   * the one that parked, so the park is held until the message closes.
   */
  private messageOpen = false;
  /** next() in flight when the turn parked; consumed on resume. */
  private pendingNext: Promise<IteratorResult<unknown>> | null = null;
  private reapTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: TurnRunnerOptions) {}

  /** MCP tool handler hook: a call was just registered in `pendingTools`. */
  readonly notifyPark = (): void => {
    this.parked = true;
    const waiters = this.parkWaiters;
    this.parkWaiters = [];
    for (const resolve of waiters) resolve();
  };

  /** The MCP server exists before the query, so the handle arrives late. */
  attach(handle: ClaudeQueryHandle): void {
    this.handle = handle;
  }

  /** SDK events until the turn ends or parks on tool calls. */
  async *events(): AsyncGenerator<unknown, void, unknown> {
    const handle = this.handle;
    if (!handle) throw new Error("TurnRunner.events() before attach()");
    this.iterator ??= handle.stream[Symbol.asyncIterator]();
    const iterator = this.iterator;
    try {
      while (true) {
        // Parked and the message is closed: hand every collected call to
        // OpenCode in one response. Claude Code already grouped the calls it
        // may run side by side (read-only ones); here they are only forwarded.
        const holding = this.parked && this.pendingTools.size > 0;
        if (holding && !this.messageOpen) {
          this.armParkReap();
          yield { type: "__park__", tools: [...this.pendingTools.values()] };
          return;
        }
        const raced = await this.nextStep(iterator, holding);
        if (raced.kind === "park") continue;
        if (raced.kind === "quiet") {
          this.messageOpen = false;
          continue;
        }
        if (raced.value.done) break;
        const event = raced.value.value;
        this.trackMessageState(event);
        this.options.onEvent?.(event);
        yield event;
      }
    } finally {
      if (!this.parked) {
        handle.close();
        deleteBridge(this.options.bridgeId);
      }
    }
  }

  /** Continue the SDK stream after every parked call was resolved. */
  async *resume(): AsyncGenerator<unknown, void, unknown> {
    this.parked = false;
    this.parkWaiters = [];
    this.clearParkReap();
    yield* this.events();
  }

  /**
   * Race the next SDK event against a park, the quiet timer (holding a park
   * while the CLI went silent: the message will not close by itself) and the
   * stall watchdog (total silence — dead process, stuck compact, wedged SDK —
   * must fail the turn truthfully instead of parking the session forever).
   */
  private async nextStep(
    iterator: AsyncIterator<unknown>,
    holding: boolean,
  ): Promise<Raced> {
    let cancelPark = (): void => {};
    const parkPromise = new Promise<Raced>((resolve) => {
      // Already parked: the message close decides, not another park.
      if (holding) return;
      const entry = () => resolve({ kind: "park" });
      this.parkWaiters.push(entry);
      cancelPark = () => {
        this.parkWaiters = this.parkWaiters.filter((w) => w !== entry);
      };
    });
    let quietTimer: ReturnType<typeof setTimeout> | null = null;
    const quietPromise = new Promise<Raced>((resolve) => {
      if (!holding) return;
      quietTimer = setTimeout(() => resolve({ kind: "quiet" }), PARK_QUIET_MS);
      quietTimer.unref?.();
    });
    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    const stallPromise = new Promise<never>((_, reject) => {
      const ms = turnStallMs();
      stallTimer = setTimeout(() => reject(stallError(ms)), ms);
      stallTimer.unref?.();
    });

    const nextPromise = this.pendingNext ?? iterator.next();
    this.pendingNext = null;
    let raced: Raced;
    try {
      raced = await Promise.race([
        nextPromise.then((value): Raced => ({ kind: "event", value })),
        parkPromise,
        quietPromise,
        stallPromise,
      ]);
    } catch (error) {
      // Stall watchdog fired — the turn is dead. Swallow the late iterator
      // settlement so it cannot surface as an unhandled rejection.
      nextPromise.then(
        () => {},
        () => {},
      );
      throw error;
    } finally {
      if (stallTimer) clearTimeout(stallTimer);
      if (quietTimer) clearTimeout(quietTimer);
      cancelPark();
    }
    // Keep the in-flight next(); the loop top decides whether to hold.
    if (raced.kind !== "event") this.pendingNext = nextPromise;
    return raced;
  }

  private trackMessageState(event: unknown): void {
    if (!event || typeof event !== "object") return;
    const e = event as Record<string, unknown>;
    // Only the stream's message_stop closes the message: the CLI emits an
    // `assistant` event after every content block, not once per message.
    if (e.type === "stream_event" && e.event && typeof e.event === "object") {
      const type = (e.event as { type?: unknown }).type;
      if (type === "message_start") this.messageOpen = true;
      if (type === "message_stop") this.messageOpen = false;
    }
  }

  /**
   * Close the turn if nothing resumes it in time: a park on StructuredOutput
   * alone is never resumed by OpenCode (one leaked CLI process per structured
   * request), and any other park is bounded by the parked-turn TTL.
   */
  private armParkReap(): void {
    this.clearParkReap();
    const structuredOnly = [...this.pendingTools.values()].every(
      (t) => t.name === STRUCTURED_OUTPUT_TOOL,
    );
    const ms = structuredOnly ? structuredOutputReapMs() : parkedTurnTtlMs();
    if (ms === null) return;
    this.reapTimer = setTimeout(() => {
      this.reapTimer = null;
      if (!this.parked) return;
      log.info(
        structuredOnly
          ? "[opencode-claude] reaping unresumed StructuredOutput park"
          : "[opencode-claude] reaping parked turn past its TTL",
        { conversationKey: this.options.conversationKey, pending: this.pendingTools.size },
      );
      deleteBridge(this.options.bridgeId);
    }, ms);
    this.reapTimer.unref?.();
  }

  private clearParkReap(): void {
    if (this.reapTimer) clearTimeout(this.reapTimer);
    this.reapTimer = null;
  }
}
