/**
 * Sticky foreign Claude session IDs for Agent SDK resume
 * (OpenChamber harness session-bindings pattern, scoped to this proxy).
 *
 * Several OpenCode processes share the store file, so every write replaces
 * the file atomically (temp file + rename): a concurrent reader sees either
 * the old or the new store, never a truncated one.
 */
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
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
   * the first user message of the latest turn delivered to it.
   */
  history?: HistoryFingerprint;
  /**
   * Last observed main-chain entry, not the last branch written to the file.
   * Another claude process writing the same session (a turn orphaned by an
   * OpenCode restart) can append a branch a plain resume would follow; the
   * resume then goes through a fork cut here (see sessionChainAfterLeaf).
   */
  leafUuid?: string;
  turns?: TurnBoundary[];
  updatedAt: number;
};

export type TurnBoundary = {
  count: number;
  hash: string;
  /** Covers earlier users too, including history imported in a single turn. */
  prefixHash?: string;
  leafUuid?: string;
  /**
   * Claude session whose file holds `leafUuid`. Boundaries survive forks and
   * keep pointing into the session they were recorded in; ones stored
   * without it belong to the binding's session.
   */
  sessionId?: string;
  /** Content checkpoint for this branch, restored when rewinding. */
  history?: HistoryFingerprint;
};

const MAX_TURN_BOUNDARIES = 100;
const written = new Map<string, ClaudeSessionBinding>();
const pendingTurns = new Map<string, TurnBoundary[]>();

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
  meta?: { modelId?: string; cwd?: string; history?: HistoryFingerprint; leafUuid?: string },
): void {
  const cached = written.get(conversationKey);
  if (cached && !pendingTurns.has(conversationKey) &&
      cached.foreignSessionId === foreignSessionId &&
      cached.modelId === meta?.modelId && cached.cwd === meta?.cwd &&
      (meta?.leafUuid === undefined || meta.leafUuid === cached.leafUuid) &&
      (meta?.history === undefined || sameHistory(meta.history, cached.history))) return;
  let next: ClaudeSessionBinding | undefined;
  updateStore((store) => {
    const previous = store[conversationKey];
    const sameSession = previous?.foreignSessionId === foreignSessionId;
    const leafUuid = meta?.leafUuid ?? (sameSession ? previous?.leafUuid : undefined);
    // Old boundaries stay across a session change (a fork), pointing into the
    // session they were recorded in, so a rewind past the fork can still cut
    // there. Untagged ones were recorded against the previous session.
    const from = sameSession ? undefined : previous?.foreignSessionId;
    const turns = pendingTurns.get(conversationKey) ?? (previous?.turns ?? []).map((turn) =>
      turn.sessionId || !from ? { ...turn } : { ...turn, sessionId: from });
    const current = turns.at(-1);
    if (current && (sameSession || leafUuid)) {
      turns[turns.length - 1] = { ...current, leafUuid, ...(leafUuid ? { sessionId: foreignSessionId } : {}) };
    }
    next = {
      conversationKey,
      foreignSessionId,
      modelId: meta?.modelId,
      cwd: meta?.cwd,
      history: meta?.history ?? (sameSession ? previous?.history : undefined),
      leafUuid,
      ...(turns.length ? { turns: turns.slice(-MAX_TURN_BOUNDARIES) } : {}),
      updatedAt: Date.now(),
    };
    if (previous && previous.foreignSessionId === next.foreignSessionId &&
        previous.modelId === next.modelId && previous.cwd === next.cwd &&
        previous.leafUuid === next.leafUuid && sameHistory(previous.history, next.history) &&
        JSON.stringify(previous.turns ?? []) === JSON.stringify(next.turns ?? [])) return false;
    store[conversationKey] = next;
    return true;
  });
  if (next) {
    written.set(conversationKey, next);
    pendingTurns.delete(conversationKey);
  }
}

export function clearForeignSessionId(conversationKey: string): void {
  written.delete(conversationKey);
  pendingTurns.delete(conversationKey);
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
  written.delete(conversationKey);
  updateStore((store) => {
    if (sameHistory(store[conversationKey]?.history, history)) return false;
    store[conversationKey] = {
      ...store[conversationKey],
      conversationKey,
      history,
      updatedAt: Date.now(),
    };
    return true;
  });
}

function sameHistory(a: HistoryFingerprint | undefined, b: HistoryFingerprint | undefined): boolean {
  return a?.count === b?.count && a?.hash === b?.hash;
}

export function userHistoryBoundary(prints: string[], history?: HistoryFingerprint): TurnBoundary | undefined {
  const hash = prints.at(-1);
  return hash ? {
    count: prints.length, hash,
    prefixHash: createHash("sha1").update(prints.join("\n")).digest("hex"),
    history,
  } : undefined;
}

export function getSessionLeafUuid(conversationKey: string): string | undefined {
  return getSessionBinding(conversationKey)?.leafUuid;
}

export function getSessionTurns(conversationKey: string): TurnBoundary[] {
  return getSessionBinding(conversationKey)?.turns ?? [];
}

/** Record the host turn; its leaf follows subsequent main-chain events. */
export function recordTurnStart(
  conversationKey: string,
  boundary: TurnBoundary,
  before?: TurnBoundary,
): void {
  written.delete(conversationKey);
  updateStore((store) => {
    const binding = store[conversationKey];
    const turns = [...(binding?.turns ?? [])];
    if (binding && turns.length === 0 && before && before.count > 0 && !sameHistory(before, boundary)) {
      turns.push(atLeaf(before, binding));
    }
    const last = turns.at(-1);
    // The next request supplies the completed previous turn's host output.
    // Keep that checkpoint with its leaf, so a rewind still detects DCP.
    if (last && before && sameHistory(last, before)) {
      turns[turns.length - 1] = { ...last, history: before.history };
    }
    if (!sameHistory(last, boundary)) {
      turns.push(atLeaf(boundary, binding));
    }
    if (!binding) {
      pendingTurns.set(conversationKey, turns.slice(-MAX_TURN_BOUNDARIES));
      return false;
    }
    if (JSON.stringify(binding.turns ?? []) === JSON.stringify(turns)) return false;
    store[conversationKey] = { ...binding, turns: turns.slice(-MAX_TURN_BOUNDARIES), updatedAt: Date.now() };
    return true;
  });
}

/** A boundary at the binding's current leaf, in the session holding it. */
function atLeaf(boundary: TurnBoundary, binding: ClaudeSessionBinding | undefined): TurnBoundary {
  return {
    ...boundary,
    leafUuid: binding?.leafUuid,
    ...(binding?.leafUuid && binding.foreignSessionId ? { sessionId: binding.foreignSessionId } : {}),
  };
}

export function rewindSessionTurns(conversationKey: string, index: number): void {
  written.delete(conversationKey);
  updateStore((store) => {
    const binding = store[conversationKey];
    const target = binding?.turns?.[index];
    if (!target || !binding.turns) return false;
    store[conversationKey] = {
      ...binding,
      // A boundary in another session (before a fork) is no leaf of this
      // one; the fork the caller cuts from it brings its own.
      leafUuid: !target.sessionId || target.sessionId === binding.foreignSessionId
        ? target.leafUuid
        : undefined,
      history: target.history,
      turns: binding.turns.slice(0, index + 1),
      updatedAt: Date.now(),
    };
    return true;
  });
}

export type TurnHistoryMatch =
  | { kind: "untracked" }
  | { kind: "latest" }
  | { kind: "rewind"; index: number; leafUuid?: string; sessionId?: string }
  | { kind: "diverged" };

export function matchTurnHistory(turns: TurnBoundary[], prints: string[]): TurnHistoryMatch {
  const latest = turns.at(-1);
  if (!latest) return { kind: "untracked" };
  // Check all retained boundaries, not only the last user: editing an
  // earlier user must still be detected with HOST_TRANSCRIPT=0.
  const agrees = (count: number) => turns.every((turn) =>
    turn.count > count || (prints[turn.count - 1] === turn.hash &&
      (!turn.prefixHash || turn.prefixHash === userHistoryBoundary(prints.slice(0, turn.count))?.prefixHash)));
  if (prints.length >= latest.count && agrees(latest.count)) return { kind: "latest" };
  for (let i = turns.length - 2; i >= 0; i--) {
    const turn = turns[i];
    if (turn.count === prints.length && agrees(turn.count)) {
      return {
        kind: "rewind", index: i, leafUuid: turn.leafUuid,
        ...(turn.sessionId ? { sessionId: turn.sessionId } : {}),
      };
    }
  }
  return { kind: "diverged" };
}

export type LeafChainState = "clean" | "branched" | "missing";

/**
 * Whether everything written after `leafUuid` in a Claude Code transcript
 * continues from it. A plain resume follows the chain the file's latest
 * last-prompt entry names; when another claude process appended a side
 * branch after our leaf, that chain may not be ours, and the CLI's
 * resumeSessionAt only searches the chain it picked ("No message found with
 * message.uuid"). So:
 * - clean: every message after the leaf descends from it; resume as is.
 * - branched: a message after the leaf hangs off another parent, or the
 *   last-prompt after it names an entry outside our chain; resume through
 *   a fork cut at the leaf.
 * - missing: the leaf isn't in the file (or the file can't be read).
 *
 * Only the tail after the leaf is parsed, reading backwards in chunks.
 */
export function sessionChainAfterLeaf(
  file: string,
  leafUuid: string,
  chunkBytes = 256 * 1024,
): LeafChainState {
  const needle = Buffer.from(`"uuid":${JSON.stringify(leafUuid)}`);
  let fd: number | undefined;
  let tail: Buffer | undefined;
  try {
    fd = openSync(file, "r");
    let end = fstatSync(fd).size;
    let window = Buffer.alloc(0);
    while (end > 0) {
      const start = Math.max(0, end - chunkBytes);
      const chunk = Buffer.alloc(end - start);
      readSync(fd, chunk, 0, chunk.length, start);
      window = Buffer.concat([chunk, window]);
      end = start;
      const at = window.lastIndexOf(needle);
      if (at < 0) continue;
      // The leaf's line starts in a chunk not read yet.
      if (window.lastIndexOf(0x0a, at) < 0 && start > 0) continue;
      const lineEnd = window.indexOf(0x0a, at);
      tail = lineEnd < 0 ? Buffer.alloc(0) : window.subarray(lineEnd + 1);
      break;
    }
  } catch {
    return "missing";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  if (!tail) return "missing";
  const chain = new Set([leafUuid]);
  // Another process finishing a turn on a side branch writes a last-prompt
  // even when its messages landed before our leaf in the file.
  let lastPromptLeaf: string | undefined;
  for (const line of tail.toString("utf8").split("\n")) {
    const entry = parseEntry(line);
    if (!entry) continue;
    if (entry.type === "last-prompt" && typeof entry.leafUuid === "string") {
      lastPromptLeaf = entry.leafUuid;
      continue;
    }
    if (typeof entry.uuid !== "string" || entry.isSidechain === true) continue;
    // A compaction boundary continues the chain through logicalParentUuid.
    const parent = typeof entry.parentUuid === "string" ? entry.parentUuid
      : typeof entry.logicalParentUuid === "string" ? entry.logicalParentUuid : undefined;
    if (parent && chain.has(parent)) chain.add(entry.uuid);
    else if (isChainMessage(entry)) return "branched";
  }
  return lastPromptLeaf && !chain.has(lastPromptLeaf) ? "branched" : "clean";
}

/**
 * Uuid of the last conversation entry in a transcript: for a fresh fork,
 * the copy of the entry it was cut at. Read backwards in chunks.
 */
export function lastChainEntryUuid(file: string, chunkBytes = 256 * 1024): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    let end = fstatSync(fd).size;
    // Bytes before the first newline seen so far: a line not yet complete.
    let rest = Buffer.alloc(0);
    while (end > 0) {
      const start = Math.max(0, end - chunkBytes);
      const chunk = Buffer.alloc(end - start);
      readSync(fd, chunk, 0, chunk.length, start);
      end = start;
      const window = Buffer.concat([chunk, rest]);
      // Bytes before the first newline may continue in the previous chunk.
      const cut = start > 0 ? window.indexOf(0x0a) : -1;
      if (start > 0 && cut < 0) {
        rest = window;
        continue;
      }
      const lines = window.subarray(cut + 1).toString("utf8").split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const entry = parseEntry(lines[i]!);
        if (entry && typeof entry.uuid === "string" && entry.isSidechain !== true && isChainMessage(entry)) {
          return entry.uuid;
        }
      }
      rest = window.subarray(0, Math.max(cut, 0));
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function parseEntry(line: string): Record<string, unknown> | undefined {
  if (!line.trim()) return undefined;
  try {
    const entry = JSON.parse(line) as unknown;
    return entry && typeof entry === "object" ? (entry as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** A conversation entry: a message or a compaction boundary. */
function isChainMessage(entry: Record<string, unknown>): boolean {
  return entry.type === "user" || entry.type === "assistant" ||
    (entry.type === "system" && entry.subtype === "compact_boundary");
}

/** Search backwards, carrying enough bytes to match across chunk borders. */
export function sessionFileHasEntry(file: string, uuid: string, chunkBytes = 256 * 1024): boolean {
  if (!Number.isInteger(chunkBytes) || chunkBytes <= 0) return false;
  const needle = Buffer.from(`"uuid":${JSON.stringify(uuid)}`);
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    let end = fstatSync(fd).size;
    let carry = Buffer.alloc(0);
    while (end > 0) {
      const start = Math.max(0, end - chunkBytes);
      const chunk = Buffer.alloc(end - start);
      const read = readSync(fd, chunk, 0, chunk.length, start);
      const window = Buffer.concat([chunk.subarray(0, read), carry]);
      if (window.includes(needle)) return true;
      carry = window.subarray(0, Math.min(window.length, needle.length - 1));
      end = start;
    }
    return false;
  } catch {
    return false; // Missing or unreadable transcript: caller selects the fallback.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
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
 * resumes via the claude CLI, which finds it across project folders even
 * when the chat's cwd changed. A missing file means resume silently starts
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
