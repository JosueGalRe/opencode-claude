/**
 * Sticky foreign Claude session IDs for Agent SDK resume
 * (OpenChamber harness session-bindings pattern, scoped to this proxy).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type HistoryFingerprint = {
  /** How many prior messages the host had sent. */
  count: number;
  /** sha1 over the prior messages' role+content, in order. */
  hash: string;
};

export type ClaudeSessionBinding = {
  conversationKey: string;
  foreignSessionId?: string;
  modelId?: string;
  cwd?: string;
  history?: HistoryFingerprint;
  updatedAt: number;
};

function storePath(): string {
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg ? xdg : join(homedir(), ".local", "share");
  return join(base, "opencode-claude", "sessions.json");
}

function readStore(): Record<string, ClaudeSessionBinding> {
  const path = storePath();
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      ClaudeSessionBinding
    >;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeStore(store: Record<string, ClaudeSessionBinding>): void {
  const path = storePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 2) + "\n", "utf8");
}

export function getForeignSessionId(
  conversationKey: string,
): string | undefined {
  const entry = readStore()[conversationKey];
  return entry?.foreignSessionId;
}

export function setForeignSessionId(
  conversationKey: string,
  foreignSessionId: string,
  meta?: { modelId?: string; cwd?: string },
): void {
  const store = readStore();
  store[conversationKey] = {
    ...store[conversationKey],
    conversationKey,
    foreignSessionId,
    modelId: meta?.modelId,
    cwd: meta?.cwd,
    updatedAt: Date.now(),
  };
  writeStore(store);
}

export function clearForeignSessionId(conversationKey: string): void {
  const store = readStore();
  if (!(conversationKey in store)) return;
  delete store[conversationKey];
  writeStore(store);
}

/**
 * Fingerprint of the host message array (role + content, in order). Used to
 * detect host-side history rewrites (context-pruning plugins, transforms):
 * on a resume candidate, the incoming array's stored-length prefix must hash
 * to the stored value, otherwise the host rewrote history and the stale
 * Claude transcript must not be resumed.
 */
export function historyFingerprint(
  messages: Array<{ role?: string; content?: unknown }>,
): HistoryFingerprint {
  const hash = createHash("sha1");
  for (const msg of messages) {
    hash.update(msg?.role ?? "");
    hash.update("");
    hash.update(JSON.stringify(msg?.content ?? null));
    hash.update("\n");
  }
  return { count: messages.length, hash: hash.digest("hex") };
}

export function getHistoryFingerprint(
  conversationKey: string,
): HistoryFingerprint | undefined {
  return readStore()[conversationKey]?.history;
}

export function setHistoryFingerprint(
  conversationKey: string,
  history: HistoryFingerprint,
): void {
  const store = readStore();
  store[conversationKey] = {
    ...store[conversationKey],
    conversationKey,
    history,
    updatedAt: Date.now(),
  };
  writeStore(store);
}

/**
 * Stable key from OpenAI messages so follow-ups resume the same Claude session.
 * Hashes the first user message only — including the message count made the key
 * change on every turn, which defeated resume entirely when the session header
 * is absent.
 */
export function conversationKeyFromMessages(
  messages: Array<{ role?: string; content?: unknown }>,
): string {
  const firstUser = messages.find((m) => m.role === "user");
  const seed =
    typeof firstUser?.content === "string"
      ? firstUser.content.slice(0, 200)
      : JSON.stringify(firstUser?.content ?? "").slice(0, 200);
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return `conv_${hash.toString(16)}`;
}

/**
 * Locate the Claude Code transcript for a foreign session id. The Agent SDK
 * resumes via the claude CLI, which looks the session up under
 * ~/.claude/projects/<cwd-slug>/ — a missing file means resume silently starts
 * (or errors into) a context-free session, so callers must fall back to
 * history injection instead.
 */
export function findClaudeSessionFile(
  foreignSessionId: string,
): string | null {
  const id = foreignSessionId.trim();
  if (!id) return null;
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  const projectsDir = join(configDir, "projects");
  let projectDirs: string[];
  try {
    projectDirs = readdirSync(projectsDir);
  } catch {
    return null;
  }
  for (const dir of projectDirs) {
    const candidate = join(projectsDir, dir, `${id}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
