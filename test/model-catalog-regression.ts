/** Offline model discovery, cache, 1M rules and refresh throttle. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "opencode-claude-models-"));
process.env.XDG_DATA_HOME = dataDir;

async function main() {
  const {
    getClaudeModels, modelNameFromId, modelsFromSdk,
    refreshClaudeModels, resolveClaudeModelId,
  } = await import("../src/models.ts");

  // Given no cache and no CLI; when discovery fails; then concrete fallback is served.
  const fallback = getClaudeModels();
  assert.ok(fallback.some((model) => model.id === "claude-haiku-4-5"));
  assert.ok(fallback.every((model) => model.id.startsWith("claude-")));
  const now = Date.now();
  assert.equal(await refreshClaudeModels(async () => null, now), false);
  assert.deepEqual(getClaudeModels(), fallback);

  // Given SDK aliases/concrete rows; when mapped; then stable ids and real limits result.
  const rows = [
    { value: "default", resolvedModel: "claude-opus-5-5" },
    { value: "opus", resolvedModel: "claude-opus-5-5", supportedEffortLevels: ["low", "high", "invalid"] },
    { value: "claude-opus-5-5", supportedEffortLevels: ["low", "high"] },
    { value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet 5.5", description: "Most efficient for simpler tasks", supportsEffort: true, supportedEffortLevels: ["medium"], supportsAdaptiveThinking: true, supportsAutoMode: true },
    { value: "claude-sonnet-4-6", resolvedModel: "claude-sonnet-4-6", displayName: "Sonnet 4.6", description: "Efficient for routine tasks", supportsEffort: true, supportedEffortLevels: ["high"], supportsAdaptiveThinking: true, supportsAutoMode: true },
    { value: "claude-opus-4-6", resolvedModel: "claude-opus-4-6", displayName: "Opus 4.6", description: "Best for everyday, complex tasks", supportsEffort: true, supportedEffortLevels: ["high"], supportsAdaptiveThinking: true, supportsAutoMode: true },
    { value: "claude-opus-4-8", supportedEffortLevels: ["max"] },
    { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", supportedEffortLevels: [] },
  ];
  assert.equal(modelNameFromId("claude-sonnet-5-5"), "Sonnet 5.5");
  const mapped = modelsFromSdk(rows);
  assert.deepEqual(mapped.map((model) => model.id), [
    "claude-opus-5-5[1m]", "claude-sonnet-5-5", "claude-sonnet-5-5[1m]",
    "claude-sonnet-4-6", "claude-opus-4-6", "claude-opus-4-6[1m]",
    "claude-opus-4-8", "claude-haiku-4-5-20251001",
  ]);
  assert.deepEqual(mapped.map((model) => [model.name, model.contextWindow, model.inputWindow]), [
    ["Opus 5.5", 1_000_000, 900_000],
    ["Sonnet 5.5", 200_000, undefined],
    ["Sonnet 5.5 (1M)", 1_000_000, 900_000],
    ["Sonnet 4.6", 200_000, undefined],
    ["Opus 4.6", 200_000, undefined],
    ["Opus 4.6 (1M)", 1_000_000, 900_000],
    ["Opus 4.8", 1_000_000, 900_000],
    ["Haiku 4.5", 200_000, undefined],
  ]);
  assert.equal(mapped.some((entry) => entry.id === "claude-sonnet-4-6[1m]"), false);
  assert.deepEqual(mapped[0]?.efforts, ["low", "high"]);
  assert.equal(mapped.at(-1)?.reasoning, false);
  assert.deepEqual(mapped.at(-1)?.efforts, []);
  assert.equal(resolveClaudeModelId("claude-opus-5-5[1m]"), "claude-opus-5-5[1m]");

  // Given a failed first probe; when ten minutes elapse; then one successful refresh writes cache.
  let probes = 0;
  const list = async () => { probes++; return rows; };
  assert.equal(await refreshClaudeModels(list, now + 60_000), false);
  assert.equal(probes, 0);
  assert.equal(await refreshClaudeModels(list, now + 600_000), true);
  assert.equal(probes, 1);
  assert.deepEqual(getClaudeModels(), mapped);
  assert.equal(resolveClaudeModelId("claude-haiku-4-5"), "claude-haiku-4-5-20251001");
  assert.deepEqual(JSON.parse(readFileSync(join(dataDir, "opencode-claude", "models.json"), "utf8")), mapped);
  assert.equal(await refreshClaudeModels(list, now + 600_001), false);
  assert.equal(probes, 1);

  // Given a persisted catalog; when a fresh process loads; then it uses the cache.
  const child = Bun.spawnSync({
    cmd: [process.execPath, "-e", "import { getClaudeModels } from './src/models.ts'; console.log(JSON.stringify(getClaudeModels()))"],
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, XDG_DATA_HOME: dataDir },
  });
  assert.equal(child.exitCode, 0, child.stderr.toString());
  assert.deepEqual(JSON.parse(child.stdout.toString()), mapped);
  console.log("ok — model catalog regression passed");
}

main().catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(() => rmSync(dataDir, { recursive: true, force: true }));
