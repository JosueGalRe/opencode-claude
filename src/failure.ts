/**
 * Classify terminal Claude turn failures so the proxy can answer with a
 * truthful HTTP status instead of a fake-200 stream that carries the error
 * as assistant text (which makes hosts retry and burn quota on doom loops).
 *
 * Mapping:
 * - auth       → 401 (non-retryable: credentials must be fixed by a human)
 * - rate_limit → 429 + Retry-After (the gate store already knows the reset)
 * - unknown    → 500
 */
import { isClaudeRateLimitText } from "./rate-limit.js";

export type ClaudeFailureKind = "auth" | "rate_limit" | "unknown";

const AUTH_FAILURE_PATTERN =
  /invalid_grant|refresh token (not found|invalid|expired)|invalid[_ -]?api[_ -]?key|authentication_error|authentication failed|unauthorized|not logged in|not authenticated|please (run )?\/?login|oauth token (is )?(expired|invalid|revoked)|access token (is )?(expired|invalid|revoked)|credentials (are )?(expired|invalid|revoked)|token (has )?expired|\b401\b/i;

export function classifyClaudeFailure(text: string): ClaudeFailureKind {
  if (!text) return "unknown";
  if (isClaudeRateLimitText(text)) return "rate_limit";
  if (AUTH_FAILURE_PATTERN.test(text)) return "auth";
  return "unknown";
}

export function failureStatusFor(kind: ClaudeFailureKind): number {
  switch (kind) {
    case "auth":
      return 401;
    case "rate_limit":
      return 429;
    default:
      return 500;
  }
}

export function failureTypeFor(kind: ClaudeFailureKind): string {
  switch (kind) {
    case "auth":
      return "authentication_error";
    case "rate_limit":
      return "rate_limit_error";
    default:
      return "server_error";
  }
}

/** User-facing guidance appended to hard failures. */
export function failureHintFor(kind: ClaudeFailureKind): string {
  switch (kind) {
    case "auth":
      return "Claude Code credentials are invalid or expired. Run `claude auth login`, then restart OpenCode — retrying is pointless until then.";
    case "rate_limit":
      return "Claude subscription limit is active; wait for the reset instead of retrying.";
    default:
      return "";
  }
}

/**
 * HTTP 429 for an active subscription limit. `retryAfterSeconds` drives the
 * host's retry countdown; `resetsAt` (epoch ms) is echoed when known.
 */
export function rateLimitResponse(
  message: string,
  retryAfterSeconds: number,
  resetsAt: number | undefined,
): Response {
  const resetsAtISO =
    resetsAt !== undefined ? new Date(resetsAt).toISOString() : undefined;
  return Response.json(
    {
      error: {
        message,
        type: failureTypeFor("rate_limit"),
        code: "claude_session_limit",
        ...(resetsAtISO ? { resets_at: resetsAtISO } : {}),
        retry_after: retryAfterSeconds,
      },
    },
    {
      status: failureStatusFor("rate_limit"),
      headers: {
        "Retry-After": String(retryAfterSeconds),
        ...(resetsAtISO ? { "x-claude-rate-limit-reset": resetsAtISO } : {}),
      },
    },
  );
}
