/**
 * Regression: the Claude CLI sign-in relay, CLI detection, and installer.
 *
 * - A superseded login child exiting late must not tear down its successor.
 * - CLI detection runs async: the host's event loop keeps turning while a
 *   slow `claude` answers its probes.
 * - The install-script fallback never runs a script whose download failed,
 *   and a double failure reports both installers' reasons.
 *
 * Run: bun test/plugin-auth-regression.ts
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installClaudeCli } from "../src/cli-install.ts";
import {
  cancelClaudeCliLogin,
  getClaudeCliLoginStatus,
  resetClaudeCliLoginForTests,
  startClaudeCliLogin,
  submitClaudeCliLoginCode,
} from "../src/cli-login.ts";
import { detectClaudeCode, type ClaudeDetectResult } from "../src/detect.ts";
import { resetClaudeCliResolutionCache } from "../src/executable-path.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function fakeLoginCli() {
  const makeStream = () => Object.assign(new EventEmitter(), { setEncoding() {} });
  const writes: string[] = [];
  const child = Object.assign(new EventEmitter(), {
    pid: 4321,
    exitCode: null as number | null,
    killed: false,
    stdout: makeStream(),
    stderr: makeStream(),
    stdin: Object.assign(new EventEmitter(), {
      writable: true,
      write(chunk: string) {
        writes.push(chunk);
        return true;
      },
    }),
    kill() {
      this.killed = true;
      return true;
    },
  });
  return { child, writes };
}

const banner = (url: string) =>
  `If the browser didn't open, visit: ${url}\nPaste code here if prompted > `;

async function startWith(child: ReturnType<typeof fakeLoginCli>["child"], url: string) {
  const pending = startClaudeCliLogin({
    binaryPath: "/usr/local/bin/claude",
    env: { PATH: "/usr/local/bin" },
    spawnLogin: () => child as never,
  });
  await tick();
  child.stdout.emit("data", banner(url));
  return pending;
}

async function staleLoginChildIsIgnored() {
  const urlA = "https://claude.com/cai/oauth/authorize?state=a";
  const urlB = "https://claude.com/cai/oauth/authorize?state=b";
  const a = fakeLoginCli();
  const b = fakeLoginCli();

  assert.deepEqual(await startWith(a.child, urlA), { state: "awaiting-code", url: urlA });
  // The URL-timeout / abandoned-dialog path kills A; its exit arrives later.
  cancelClaudeCliLogin();
  assert.equal(a.child.killed, true);

  assert.deepEqual(await startWith(b.child, urlB), { state: "awaiting-code", url: urlB });

  // A's late output and exit belong to a dead flow.
  a.child.stdout.emit("data", banner("https://claude.com/cai/oauth/authorize?state=stale"));
  a.child.stderr.emit("data", "Invalid code. stale\n");
  a.child.exitCode = 143;
  a.child.emit("exit", null, "SIGTERM");

  assert.deepEqual(getClaudeCliLoginStatus(), { state: "awaiting-code", url: urlB });
  // Retrying reuses B and its URL, not the stale one A printed.
  const resumed = await startClaudeCliLogin({
    binaryPath: "/usr/local/bin/claude",
    spawnLogin: () => {
      throw new Error("B is live and must be reused");
    },
  });
  assert.deepEqual(resumed, { state: "awaiting-code", url: urlB });

  const submitted = submitClaudeCliLoginCode("code-for-b");
  assert.deepEqual(b.writes, ["code-for-b\n"]);
  assert.deepEqual(a.writes, []);
  await tick();
  b.child.exitCode = 0;
  b.child.emit("exit", 0, null);
  assert.deepEqual(await submitted, { ok: true });
  assert.deepEqual(getClaudeCliLoginStatus(), { state: "succeeded" });
  resetClaudeCliLoginForTests();

  // Cancel still reaches the current child after a stale exit.
  const c = fakeLoginCli();
  const d = fakeLoginCli();
  await startWith(c.child, urlA);
  cancelClaudeCliLogin();
  await startWith(d.child, urlB);
  c.child.emit("exit", null, "SIGTERM");
  cancelClaudeCliLogin();
  assert.equal(d.child.killed, true, "successor stays reachable by cancel");
  resetClaudeCliLoginForTests();
}

async function detectionKeepsEventLoopTurning() {
  const dir = mkdtempSync(join(tmpdir(), "opencode-claude-slow-cli-"));
  try {
    const cli = join(dir, "claude");
    writeFileSync(
      cli,
      `#!/bin/sh
sleep 0.4
case "$1" in
  --version) echo "2.1.300 (Claude Code)" ;;
  auth) echo '{"loggedIn":true,"authMethod":"claude.ai"}' ;;
esac
`,
    );
    chmodSync(cli, 0o755);
    resetClaudeCliResolutionCache();

    let ticks = 0;
    const ticker = setInterval(() => {
      ticks += 1;
    }, 20);
    const started = Date.now();
    let detection: ClaudeDetectResult;
    try {
      detection = await detectClaudeCode({
        env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir },
      });
    } finally {
      clearInterval(ticker);
    }
    const elapsed = Date.now() - started;

    assert.equal(detection.binaryPath, cli);
    assert.equal(detection.version, "2.1.300");
    assert.equal(detection.loggedIn, true, "async auth status probe parsed");
    // Three probes of ~400ms each; a synchronous spawn would freeze the
    // timer for their whole duration.
    assert.ok(elapsed >= 1_000, `probes actually ran (${elapsed}ms)`);
    assert.ok(
      ticks >= elapsed / 20 / 2,
      `event loop stalled during detection: ${ticks} ticks in ${elapsed}ms`,
    );
  } finally {
    resetClaudeCliResolutionCache();
    rmSync(dir, { recursive: true, force: true });
  }
}

function fakeInstaller() {
  const streams = { stdout: new EventEmitter(), stderr: new EventEmitter() };
  const child = Object.assign(new EventEmitter(), {
    pid: 7,
    stdout: streams.stdout,
    stderr: streams.stderr,
    kill() {
      return true;
    },
  });
  return { child, streams };
}

type InstallStep = { exit: number; stderr?: string };

async function runInstall(steps: Record<string, InstallStep>) {
  const calls: string[][] = [];
  const result = await installClaudeCli({
    env: { PATH: "/usr/bin" },
    spawnInstall(command, args) {
      calls.push([command, ...args]);
      const step = steps[command];
      assert.ok(step, `unexpected installer spawn: ${command}`);
      const { child, streams } = fakeInstaller();
      process.nextTick(() => {
        if (step.stderr) streams.stderr.emit("data", step.stderr);
        child.emit("exit", step.exit);
      });
      return child as never;
    },
  });
  return { result, calls };
}

async function installScriptRunsOnlyAfterCompleteDownload() {
  // Download failed: the script must not run, and both reasons surface.
  {
    const { result, calls } = await runInstall({
      npm: { exit: 243, stderr: "npm ERR! code EACCES\n" },
      curl: { exit: 6, stderr: "curl: (6) Could not resolve host: claude.ai\n" },
    });
    assert.equal(result.ok, false);
    const message = result.ok ? "" : result.message;
    assert.match(message, /Could not resolve host/);
    assert.match(message, /npm ERR! code EACCES/);
    assert.deepEqual(
      calls.map((call) => call[0]),
      ["npm", "curl"],
      "a failed download is never executed",
    );
  }

  // Download succeeded: bash runs exactly the file curl wrote, no pipe.
  {
    const { result, calls } = await runInstall({
      npm: { exit: 127, stderr: "npm: not found\n" },
      curl: { exit: 0 },
      bash: { exit: 0 },
    });
    assert.deepEqual(result, { ok: true });
    const [, curl, bash] = calls;
    const outIndex = curl!.indexOf("-o");
    assert.ok(outIndex > 0, "curl writes to a file");
    assert.ok(
      curl!.some((arg) => /^-[A-Za-z]*f/.test(arg)),
      "curl fails on HTTP errors instead of saving an error page",
    );
    assert.deepEqual(bash, ["bash", curl![outIndex + 1]]);
    assert.ok(calls.flat().every((arg) => !arg.includes("|")), "no shell pipe");
  }
}

async function v1RequestsCarryProxyToken() {
  const dataDir = mkdtempSync(join(tmpdir(), "opencode-claude-v1-auth-"));
  process.env.XDG_DATA_HOME = dataDir;
  process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE = join(dataDir, "rate-limit.json");
  // Loaded after the env overrides: the proxy resolves its data dir on load.
  const { ClaudeCodePlugin } = await import("../src/index.ts");
  const { PROVIDER_ID, PROXY_TOKEN_HEADER } = await import("../src/constants.ts");
  const { getProxyAuthToken, stopProxy } = await import("../src/proxy.ts");
  try {
    const hooks = await ClaudeCodePlugin({ directory: "/work/v1" } as never);
    const token = getProxyAuthToken();

    // A placeholder key left in user config must not shadow the live secret.
    const config = {
      provider: { [PROVIDER_ID]: { options: { apiKey: "claude-code-proxy" } } },
    };
    await hooks.config!(config as never);
    assert.equal(config.provider[PROVIDER_ID]!.options.apiKey, token);

    const output = { headers: {} as Record<string, string> };
    await hooks["chat.headers"]!(
      {
        sessionID: "sess-v1",
        model: { providerID: PROVIDER_ID, id: "sonnet" },
        message: { model: {} },
      } as never,
      output,
    );
    assert.equal(output.headers[PROXY_TOKEN_HEADER], token);
  } finally {
    await stopProxy();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

async function main() {
  await staleLoginChildIsIgnored();
  await detectionKeepsEventLoopTurning();
  await installScriptRunsOnlyAfterCompleteDownload();
  await v1RequestsCarryProxyToken();
  console.log("ok — plugin auth regression passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
