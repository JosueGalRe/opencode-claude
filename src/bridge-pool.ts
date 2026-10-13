/**
 * Parked Claude Agent SDK turns waiting for OpenCode tool results
 * (Cursor bridge-pool pattern).
 */
import { withGracefulStop, type ClaudeQueryHandle } from "./query.js";
import type { McpToolResultContent } from "./prompt.js";

export type ParkedToolCall = {
  id: string;
  name: string;
  arguments: string;
  resolve: (result: McpToolResultContent[]) => void;
  reject: (error: Error) => void;
};

export type ParkedBridge = {
  id: string;
  conversationKey: string;
  metaKind?: string | null;
  handle: ClaudeQueryHandle;
  pendingTools: Map<string, ParkedToolCall>;
  /** SDK assistant messages whose usage was already reported to OpenCode. */
  seenAssistantUsageIds: Set<string>;
  /** Continues the turn's SDK stream once every parked call is resolved. */
  resume: () => AsyncGenerator<unknown, void, unknown>;
};

/**
 * Turns live in the process, not in a copy of this module. OpenCode reloads
 * a plugin (dist rebuilt, config changed, idle location torn down) by
 * unloading its copy and importing a fresh one; a turn parked on a tool must
 * survive that and be resumed by whichever copy receives its results. Bump
 * the key's version when ParkedBridge changes shape: a reload across that
 * change then starts with a fresh pool instead of misreading old turns.
 */
type BridgeRuntime = {
  bridges: Map<string, ParkedBridge>;
  stopping: Map<string, Set<Promise<void>>>;
  /** Plugin instances holding the proxy, across every copy of the module. */
  holders: number;
  /** Stop of every turn, scheduled after the last instance released. */
  shutdownTimer?: ReturnType<typeof setTimeout>;
  exitHook?: boolean;
};

const RUNTIME_KEY = Symbol.for("@josuegalre/opencode-claude/bridge-runtime/v1");

export const bridgeRuntime: BridgeRuntime = ((globalThis as Record<symbol, unknown>)[RUNTIME_KEY] ??= {
  bridges: new Map(),
  stopping: new Map(),
  holders: 0,
}) as BridgeRuntime;

const bridges = bridgeRuntime.bridges;
const stopping = bridgeRuntime.stopping;

// A quitting OpenCode doesn't wait out the reload grace period: close the
// CLIs, so none keeps writing to a session nobody resumes (a side branch).
if (!bridgeRuntime.exitHook) {
  bridgeRuntime.exitHook = true;
  process.once("exit", () => {
    for (const id of [...bridges.keys()]) deleteBridge(id);
  });
}

export function putBridge(bridge: ParkedBridge): void {
  // Starts are serialized and stop the previous writer before spawning.
  for (const [id, existing] of bridges) {
    if (existing.conversationKey === bridge.conversationKey && id !== bridge.id) {
      void stopBridge(id, "Superseded by a newer turn");
    }
  }
  bridges.set(bridge.id, bridge);
}

export function getBridge(id: string): ParkedBridge | undefined {
  return bridges.get(id);
}

export function findBridgeByConversation(
  conversationKey: string,
): ParkedBridge | undefined {
  for (const bridge of bridges.values()) {
    if (bridge.conversationKey === conversationKey) return bridge;
  }
  return undefined;
}

export function findBridgeByPendingTool(
  toolCallId: string,
): ParkedBridge | undefined {
  for (const bridge of bridges.values()) {
    if (bridge.pendingTools.has(toolCallId)) return bridge;
  }
  return undefined;
}

export function deleteBridge(id: string): void {
  const bridge = bridges.get(id);
  if (!bridge) return;
  bridges.delete(id);
  for (const tool of bridge.pendingTools.values()) {
    tool.reject(new Error("Bridge closed"));
  }
  bridge.pendingTools.clear();
  try {
    bridge.handle.close();
  } catch {
    // ignore — the CLI child may already be gone
  }
}

/** Remove immediately, but keep the settling stop visible to the next spawn. */
export function stopBridge(id: string, reason = "Bridge closed"): Promise<void> {
  const bridge = bridges.get(id);
  if (!bridge) return Promise.resolve();
  bridges.delete(id);
  const key = bridge.conversationKey;
  const pending = stopping.get(key) ?? new Set<Promise<void>>();
  stopping.set(key, pending);
  const stop = (async () => {
    try {
      await withGracefulStop(bridge.handle).stop();
    } finally {
      // Reject only after interrupt/settle: otherwise the CLI may answer the
      // tool error with another model call before its interrupt arrives.
      for (const tool of bridge.pendingTools.values()) tool.reject(new Error(reason));
      bridge.pendingTools.clear();
    }
  })();
  pending.add(stop);
  const finished = () => {
    pending.delete(stop);
    if (!pending.size && stopping.get(key) === pending) stopping.delete(key);
  };
  void stop.then(finished, finished);
  return stop;
}

/** Resolves to how many active bridges it stopped. */
export async function stopConversationBridges(conversationKey: string, reason?: string): Promise<number> {
  const stops = [...bridges.values()]
    .filter((bridge) => bridge.conversationKey === conversationKey)
    .map((bridge) => stopBridge(bridge.id, reason));
  await Promise.all([...stops, ...(stopping.get(conversationKey) ?? [])]);
  return stops.length;
}

/** Shutdown also waits for stops already removed from the active pool. */
export async function clearAllBridges(): Promise<void> {
  const stops = [...bridges.keys()].map((id) => stopBridge(id));
  await Promise.all([...stops, ...[...stopping.values()].flatMap((pending) => [...pending])]);
}

export function deleteBridgesByConversation(conversationKey: string): void {
  for (const bridge of [...bridges.values()]) {
    if (bridge.conversationKey === conversationKey) void stopBridge(bridge.id);
  }
}
