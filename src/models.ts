/** Claude Code model catalog, discovered from the local CLI. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { EFFORT_LEVELS, isClaudeEffort, type ClaudeEffort } from "./constants.js";

export type ClaudeModel = {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  inputWindow?: number;
  efforts: ClaudeEffort[];
};

const LIMIT_1M = { context: 1_000_000, input: 900_000, output: 128_000 } as const;
const LIMIT_200K = { context: 200_000, output: 64_000 } as const;
const MODEL_REFRESH_INTERVAL_MS = 10 * 60_000;

/** OpenCode may inject these before merging plugin variants — disable extras. */
export const GENERATED_VARIANT_KEYS = [
  "none", "minimal", "low", "medium", "high", "xhigh", "max",
] as const;

function model(
  id: string,
  name: string,
  limit: { context: number; input?: number; output: number },
  efforts: ClaudeEffort[] = [...EFFORT_LEVELS],
): ClaudeModel {
  return {
    id, name,
    reasoning: efforts.length > 0,
    contextWindow: limit.context,
    maxTokens: limit.output,
    ...(limit.input ? { inputWindow: limit.input } : {}),
    efforts,
  };
}

/** Used before discovery or when the CLI is unavailable. No moving aliases. */
const FALLBACK_MODELS: ClaudeModel[] = [
  model("claude-opus-5-5[1m]", "Opus 5.5", LIMIT_1M),
  model("claude-fable-5-1[1m]", "Fable 5.1", LIMIT_1M),
  model("claude-sonnet-5", "Sonnet 5", LIMIT_200K),
  model("claude-sonnet-5[1m]", "Sonnet 5 (1M)", LIMIT_1M),
  model("claude-haiku-4-5", "Haiku 4.5", LIMIT_200K, []),
  model("claude-opus-4-8", "Opus 4.8", LIMIT_1M),
];

export type SdkModelRow = {
  value: string;
  displayName?: string;
  resolvedModel?: string;
  supportedEffortLevels?: string[];
};

/** default: only 1M; optional: both; fixed: plain id already uses 1M. */
const ONE_M_FAMILIES: Array<{ match: RegExp; mode: "default" | "optional" | "fixed" }> = [
  { match: /^claude-fable-5/, mode: "default" },
  { match: /^claude-opus-5/, mode: "default" },
  // ponytail: Opus 4.6/Sonnet 4.6 entitlement is hand-maintained from anthropics/claude-code #34773/#41121 and CC 2.1.75; revisit when Anthropic changes 1M billing.
  { match: /^claude-opus-4-6/, mode: "optional" },
  { match: /^claude-opus-4-[78]/, mode: "fixed" },
  { match: /^claude-sonnet-5/, mode: "optional" },
];

export function modelNameFromId(id: string | undefined): string | undefined {
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[1m\])?$/i.exec(id?.trim() ?? "");
  if (!match) return undefined;
  const family = match[1];
  if (!family) return undefined;
  return `${family.charAt(0).toUpperCase()}${family.slice(1).toLowerCase()} ${match[2]}${match[3] ? `.${match[3]}` : ""}`;
}

/** The CLI's default/alias rows are deduped under their concrete ids. */
export function modelsFromSdk(rows: SdkModelRow[]): ClaudeModel[] {
  const out: ClaudeModel[] = [];
  for (const row of rows) {
    const value = row.value?.trim();
    if (!value || value === "default") continue;
    const base = (row.resolvedModel || value).replace(/\[1m\]$/i, "");
    const name = modelNameFromId(base) ?? row.displayName?.trim() ?? base;
    const efforts = (row.supportedEffortLevels ?? []).filter(isClaudeEffort);
    const rule = /\[1m\]$/i.test(value)
      ? { mode: "default" as const }
      : ONE_M_FAMILIES.find((family) => family.match.test(base));
    if (rule?.mode === "default") {
      out.push(model(`${base}[1m]`, name, LIMIT_1M, efforts));
    } else if (rule?.mode === "fixed") {
      out.push(model(base, name, LIMIT_1M, efforts));
    } else if (rule?.mode === "optional") {
      out.push(model(base, name, LIMIT_200K, efforts));
      out.push(model(`${base}[1m]`, `${name} (1M)`, LIMIT_1M, efforts));
    } else {
      out.push(model(base, name, LIMIT_200K, efforts));
    }
  }
  const seen = new Set<string>();
  return out.filter((entry) => !seen.has(entry.id) && seen.add(entry.id));
}

const cachedModelSchema = z.object({
  id: z.string(), name: z.string(), reasoning: z.boolean(),
  contextWindow: z.number(), maxTokens: z.number(),
  inputWindow: z.number().optional(),
  efforts: z.array(z.enum(EFFORT_LEVELS)),
});

function modelCachePath(): string {
  const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(base, "opencode-claude", "models.json");
}

function readCachedModels(): ClaudeModel[] | null {
  try {
    const parsed = z.array(cachedModelSchema).safeParse(JSON.parse(readFileSync(modelCachePath(), "utf8")));
    return parsed.success && parsed.data.length ? parsed.data : null;
  } catch {
    return null;
  }
}

let discovered: ClaudeModel[] | null = readCachedModels();
let lastModelRefresh = 0;

export function getClaudeModels(): ClaudeModel[] {
  return discovered?.length ? discovered : FALLBACK_MODELS;
}

export function setDiscoveredModels(models: ClaudeModel[]): boolean {
  if (!models.length) return false;
  const changed = JSON.stringify(models) !== JSON.stringify(discovered);
  discovered = models;
  if (changed) {
    try {
      const file = modelCachePath();
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(models, null, 2));
    } catch {
      // Cache is optional; the current process still uses discovery.
    }
  }
  return changed;
}

/** Single throttle shared by V1 and V2; the caller schedules this in the background. */
export async function refreshClaudeModels(
  list: () => Promise<SdkModelRow[] | null>,
  now = Date.now(),
): Promise<boolean> {
  if (now - lastModelRefresh < MODEL_REFRESH_INTERVAL_MS) return false;
  lastModelRefresh = now;
  const rows = await list();
  return rows?.length ? setDiscoveredModels(modelsFromSdk(rows)) : false;
}

export function resolveClaudeModelId(modelId: string): string {
  // OpenCode title/summary requests still address Haiku by its short id;
  // supportedModels() may return only a dated concrete Haiku id.
  if (modelId === "claude-haiku-4-5") {
    return getClaudeModels().find((entry) => entry.id === modelId || entry.id.startsWith(`${modelId}-`))?.id ?? modelId;
  }
  return modelId;
}

export function buildEffortVariants(
  model: ClaudeModel,
): Record<string, { effort: ClaudeEffort } | { disabled: true }> {
  const variants: Record<string, { effort: ClaudeEffort } | { disabled: true }> =
    Object.fromEntries(model.efforts.map((effort) => [effort, { effort }]));
  for (const key of GENERATED_VARIANT_KEYS) {
    if (!(key in variants)) variants[key] = { disabled: true };
  }
  return variants;
}

export function buildConfigVariants(
  model: ClaudeModel,
): Record<string, { effort: ClaudeEffort } | { disabled: true }> {
  return buildEffortVariants(model);
}
