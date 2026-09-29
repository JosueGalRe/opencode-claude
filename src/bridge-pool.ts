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

const bridges = new Map<string, ParkedBridge>();
const stopping = new Map<string, Set<Promise<void>>>();

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

export async function stopConversationBridges(conversationKey: string, reason?: string): Promise<void> {
  const stops = [...bridges.values()]
    .filter((bridge) => bridge.conversationKey === conversationKey)
    .map((bridge) => stopBridge(bridge.id, reason));
  await Promise.all([...stops, ...(stopping.get(conversationKey) ?? [])]);
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
