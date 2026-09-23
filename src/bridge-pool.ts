/**
 * Parked Claude Agent SDK turns waiting for OpenCode tool results
 * (Cursor bridge-pool pattern).
 */
import type { ClaudeQueryHandle } from "./query.js";
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
  handle: ClaudeQueryHandle;
  pendingTools: Map<string, ParkedToolCall>;
  /** SDK assistant messages whose usage was already reported to OpenCode. */
  seenAssistantUsageIds: Set<string>;
  createdAt: number;
  /** Continues consuming the SDK stream after tools resolve. */
  continueStream?: () => AsyncGenerator<unknown, void, unknown>;
};

const bridges = new Map<string, ParkedBridge>();

export function putBridge(bridge: ParkedBridge): void {
  // One active bridge per conversation — drop any prior turn for this key.
  for (const [id, existing] of bridges) {
    if (existing.conversationKey === bridge.conversationKey && id !== bridge.id) {
      for (const tool of existing.pendingTools.values()) {
        tool.reject(new Error("Superseded by a newer turn"));
      }
      existing.pendingTools.clear();
      try {
        existing.handle.close();
      } catch {
        // ignore
      }
      bridges.delete(id);
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
  try {
    bridge.handle.close();
  } catch {
    // ignore — the CLI child may already be gone
  }
}

/** Close every parked turn's Claude CLI child (proxy shutdown). */
export function clearAllBridges(): void {
  for (const id of [...bridges.keys()]) {
    deleteBridge(id);
  }
}

export function deleteBridgesByConversation(conversationKey: string): void {
  for (const bridge of [...bridges.values()]) {
    if (bridge.conversationKey === conversationKey) deleteBridge(bridge.id);
  }
}
