/**
 * Sticky foreign Claude session IDs for Agent SDK resume
 * (OpenChamber harness session-bindings pattern, scoped to this proxy).
 *
 * Several OpenCode processes share the store file, so every write replaces
 * the file atomically (temp file + rename): a concurrent reader sees either
 * the old or the new store, never a truncated one.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { log } from "./log.js";

/** Bindings untouched for this long are dropped on the next write. */
const BINDING_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export type HistoryFingerprint = {
  /** How many prior (non-system) messages the host had sent. */
  count: number;
  /** sha1 over the prior messages' role+content, in order. */
  hash: string;
};

export type ClaudeSessionBinding = {
  conversationKey: string;
  foreignSessionId?: string;
  modelId?: string;
  cwd?: string;
  /**
   * Host messages the bound Claude session has seen, up to (not including)
   * the last user message delivered to it.
   */
  history?: HistoryFingerprint;
  updatedAt: number;
};

type Store = Record<string, ClaudeSessionBinding>;

function storePath(): string {
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg ? xdg : join(homedir(), ".local", "share");
  return join(base, "opencode-claude", "sessions.json");
}

/** Parsed store, `{}` when absent, `null` when the file is unreadable. */
function readStore(): Store | null {
  const path = storePath();
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Store)
      : null;
  } catch {
    return null;
  }
}

/**
 * Read-modify-write. An unreadable store is moved aside (kept for
 * inspection) instead of being silently overwritten with a single entry.
 */
function updateStore(mutate: (store: Store) => boolean): void {
  const path = storePath();
  let store = readStore();
  if (store === null) {
    const backup = `${path}.corrupt-${Date.now()}`;
    try {
      renameSync(path, backup);
      log.warn("[opencode-claude] session store unreadable; moved aside", {
        backup,
      });
    } catch (err) {
      log.warn(
        "[opencode-claude] session store unreadable; skipping write",
        err instanceof Error ? err.message : err,
      );
      return;
    }
    store = {};
  }
  if (!mutate(store)) return;
  const cutoff = Date.now() - BINDING_MAX_AGE_MS;
  for (const [key, entry] of Object.entries(store)) {
    if (!(typeof entry?.updatedAt === "number" && entry.updatedAt >= cutoff)) {
      delete store[key];
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

export function getSessionBinding(
  conversationKey: string,
): ClaudeSessionBinding | undefined {
  return readStore()?.[conversationKey];
}

export function getForeignSessionId(
  conversationKey: string,
): string | undefined {
  return readStore()?.[conversationKey]?.foreignSessionId;
}

export function setForeignSessionId(
  conversationKey: string,
  foreignSessionId: string,
  meta?: { modelId?: string; cwd?: string; history?: HistoryFingerprint },
): void {
  updateStore((store) => {
    const previous = store[conversationKey];
    store[conversationKey] = {
      ...previous,
      conversationKey,
      foreignSessionId,
      modelId: meta?.modelId,
      cwd: meta?.cwd,
      history: meta?.history ?? previous?.history,
      updatedAt: Date.now(),
    };
    return true;
  });
}

export function clearForeignSessionId(conversationKey: string): void {
  updateStore((store) => {
    if (!(conversationKey in store)) return false;
    delete store[conversationKey];
    return true;
  });
}

/**
 * Fingerprint of the host message array (role + content, in order). Used to
 * detect host-side history rewrites (context-pruning plugins, transforms):
 * on a resume candidate, the incoming array's stored-length prefix must hash
 * to the stored value, otherwise the host rewrote history and the stale
 * Claude transcript must not be resumed.
 *
 * System messages are skipped: OpenCode rebuilds its system prompt on every
 * request (model name, date, agent, AGENTS.md), and the proxy re-applies it
 * per query instead of replaying it from the Claude transcript. `count`
 * therefore counts non-system messages only; compare against
 * `nonSystemMessages(...)` slices.
 */
export function historyFingerprint(
  messages: Array<{ role?: string; content?: unknown }>,
): HistoryFingerprint {
  const history = nonSystemMessages(messages);
  const hash = createHash("sha1");
  for (const msg of history) {
    hash.update(msg?.role ?? "");
    hash.update("");
    hash.update(JSON.stringify(msg?.content ?? null));
    hash.update("\n");
  }
  return { count: history.length, hash: hash.digest("hex") };
}

export function nonSystemMessages<T extends { role?: string }>(
  messages: T[],
): T[] {
  return messages.filter((msg) => msg?.role !== "system");
}

export function setHistoryFingerprint(
  conversationKey: string,
  history: HistoryFingerprint,
): void {
  updateStore((store) => {
    store[conversationKey] = {
      ...store[conversationKey],
      conversationKey,
      history,
      updatedAt: Date.now(),
    };
    return true;
  });
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
