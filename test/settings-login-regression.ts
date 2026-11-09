/**
 * Utility turns (titles, summaries without a session, the model list) load no
 * Claude Code setting sources. A login configured in the user's settings
 * file, such as a gateway's endpoint and token in its `env`, must still reach
 * them; before, titles failed with "Not logged in" while chat turns worked.
 * They get the settings `env` block, as chats do; credentials inherited from
 * the OpenCode process stay removed.
 *
 * Run: bun test/settings-login-regression.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readClaudeSettingsEnv } from "../src/auth-env.ts";
import { startClaudeQuery } from "../src/query.ts";

const configDir = mkdtempSync(join(tmpdir(), "opencode-claude-settings-"));
const writeSettings = (content: string) => writeFileSync(join(configDir, "settings.json"), content);

const childEnv = async (settingSources: Array<"user" | "project" | "local"> | undefined) => {
  let seen: Record<string, unknown> | null = null;
  await startClaudeQuery({
    prompt: "x",
    cwd: process.cwd(),
    settingSources,
    pathToClaudeCodeExecutable: "/bin/true",
    env: {
      PATH: "/bin",
      CLAUDE_CONFIG_DIR: configDir,
      ANTHROPIC_AUTH_TOKEN: "inherited-token",
      CLAUDE_CODE_OAUTH_TOKEN: "inherited-oauth",
    },
    queryImpl: () => (input: { options: Record<string, unknown> }) => {
      seen = input.options;
      return (async function* () {})();
    },
  });
  assert.ok(seen);
  return (seen as Record<string, unknown>).env as Record<string, string | undefined>;
};

try {
  // Given no settings file; then nothing is added.
  assert.deepEqual(await readClaudeSettingsEnv({ CLAUDE_CONFIG_DIR: configDir }), {});

  // Given a malformed file; then nothing is added and the turn still starts.
  writeSettings("{ not json");
  assert.deepEqual(await readClaudeSettingsEnv({ CLAUDE_CONFIG_DIR: configDir }), {});
  assert.equal((await childEnv([])).ANTHROPIC_AUTH_TOKEN, undefined);

  // Given a gateway login in the settings env, next to unrelated settings.
  writeSettings(JSON.stringify({
    model: "opus",
    hooks: { Stop: [] },
    env: {
      ANTHROPIC_BASE_URL: "https://gateway.example",
      ANTHROPIC_AUTH_TOKEN: "settings-token",
      ANTHROPIC_API_KEY: 42,
      NODE_EXTRA_CA_CERTS: "/etc/gateway-ca.pem",
    },
  }));
  assert.deepEqual(
    await readClaudeSettingsEnv({ CLAUDE_CONFIG_DIR: configDir }),
    {
      ANTHROPIC_BASE_URL: "https://gateway.example",
      ANTHROPIC_AUTH_TOKEN: "settings-token",
      NODE_EXTRA_CA_CERTS: "/etc/gateway-ca.pem",
    },
    "only the env block's string values are taken",
  );

  // When a turn loads no user settings; then the settings env reaches it.
  for (const sources of [[], ["project"]] as Array<Array<"project">>) {
    const utility = await childEnv(sources);
    assert.equal(utility.ANTHROPIC_BASE_URL, "https://gateway.example");
    assert.equal(utility.ANTHROPIC_AUTH_TOKEN, "settings-token", "the settings token, not the inherited one");
    assert.equal(utility.NODE_EXTRA_CA_CERTS, "/etc/gateway-ca.pem");
    assert.equal(utility.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.equal(utility.ANTHROPIC_API_KEY, undefined);
  }

  // When a turn loads user settings; then Claude Code reads the file itself.
  const chat = await childEnv(undefined);
  assert.equal(chat.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(chat.ANTHROPIC_BASE_URL, undefined);
} finally {
  rmSync(configDir, { recursive: true, force: true });
}

console.log("ok — settings login regression passed");
