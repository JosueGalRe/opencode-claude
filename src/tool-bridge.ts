/**
 * OpenCode tools exposed to Claude Code as the in-process `opencode` MCP
 * server. Handlers never run the tool: they register a ParkedToolCall and
 * park the turn (see TurnRunner); OpenCode executes the call under its own
 * permission rules and the next request resolves it.
 */
import { randomUUID } from "node:crypto";
import type { ParkedToolCall } from "./bridge-pool.js";
import { log } from "./log.js";
import type { McpToolResultContent } from "./prompt.js";
import { fitToolDescription } from "./tool-description.js";

export type OpenAITool = {
  type?: string;
  function?: {
    name?: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
};

/** Names of the OpenCode tools a request offers. */
export function openCodeToolNames(tools: OpenAITool[]): string[] {
  return tools
    .map((t) => t.function?.name)
    .filter((n): n is string => typeof n === "string" && n.length > 0);
}

export function bridgedToolName(name: string): string {
  return `mcp__opencode__${name}`;
}

/**
 * Claude Code habitually calls its built-in names (Bash, Read, TodoWrite…);
 * route each to the bridged OpenCode tool. Capitalising the OpenCode name
 * covers most built-ins; the todo tools are camel-cased. Those must land on
 * OpenCode's todo tools or plans die with the turn (never persisted or
 * transferred).
 */
const CAMEL_CASED_BUILTINS: Record<string, string> = {
  todowrite: "TodoWrite",
  todoread: "TodoRead",
};

export function bridgedToolAliases(names: string[]): Record<string, string> {
  const aliases: Record<string, string> = {};
  for (const name of names) {
    const target = bridgedToolName(name);
    aliases[name] = target;
    aliases[name.charAt(0).toUpperCase() + name.slice(1)] = target;
    if (Object.hasOwn(CAMEL_CASED_BUILTINS, name)) {
      aliases[CAMEL_CASED_BUILTINS[name]] = target;
    }
  }
  return aliases;
}

/**
 * OpenCode tools that only read, annotated `readOnlyHint: true` for Claude
 * Code. The CLI runs MCP tool calls one at a time unless the tool carries
 * that annotation; annotated calls that sit next to each other in one
 * assistant message form a group the CLI starts together (a non-annotated
 * call in between splits the group). The plugin does not group anything: it
 * forwards what the CLI started within one message as one response, and
 * OpenCode runs those calls side by side (see TurnRunner).
 * `task` is listed on purpose (Claude Code's own Agent tool is concurrency
 * safe). Tools that write (edit, write, patch, bash, ...) must stay out.
 */
const PARALLEL_SAFE_TOOLS = new Set([
  "read",
  "glob",
  "grep",
  "list",
  "codesearch",
  "webfetch",
  "websearch",
  "todoread",
  "skill",
  "lsp_diagnostics",
  "lsp_hover",
  "task",
]);

/** The CLI starts the leading consecutive read-only calls together. */
export function expectedParallelGroup(names: readonly string[]): number {
  let count = 0;
  for (const name of names) {
    if (!PARALLEL_SAFE_TOOLS.has(name)) break;
    count++;
  }
  return Math.max(1, count);
}

/** JSON Schema types a property accepts; empty when it constrains none. */
function schemaTypes(schema: unknown): string[] {
  if (!schema || typeof schema !== "object") return [];
  const { type, anyOf, oneOf } = schema as {
    type?: unknown;
    anyOf?: unknown;
    oneOf?: unknown;
  };
  if (typeof type === "string") return [type];
  if (Array.isArray(type)) return type.filter((t): t is string => typeof t === "string");
  const variants = [anyOf, oneOf].find(Array.isArray) as unknown[] | undefined;
  if (!variants) return [];
  const types = variants.map(schemaTypes);
  return types.some((t) => t.length === 0) ? [] : types.flat();
}

/**
 * Claude sometimes sends a scalar or JSON argument as its string encoding
 * ("true", "300000", a JSON array). Claude Code's own tools accept that, so
 * decode a string for a parameter that cannot take one; anything that does
 * not decode to an accepted type is left for validation to reject.
 */
export function coerceStringArgument(value: unknown, schema: unknown): unknown {
  if (typeof value !== "string") return value;
  const types = schemaTypes(schema);
  if (types.length === 0 || types.includes("string")) return value;
  const text = value.trim();
  if (types.includes("boolean") && (text === "true" || text === "false")) {
    return text === "true";
  }
  if ((types.includes("number") || types.includes("integer")) && text !== "") {
    const number = Number(text);
    if (
      Number.isFinite(number) &&
      (types.includes("number") || Number.isInteger(number))
    ) {
      return number;
    }
  }
  if (types.includes("null") && text === "null") return null;
  if (types.includes("array") || types.includes("object")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (
        Array.isArray(parsed)
          ? types.includes("array")
          : parsed !== null && typeof parsed === "object" && types.includes("object")
      ) {
        return parsed;
      }
    } catch {}
  }
  return value;
}

/** JSON Schema (stringified) -> SDK-verified zod shape, or null. */
const faithfulShapeCache = new Map<string, Record<string, unknown> | null>();

export async function buildOpenCodeMcpServer(
  tools: OpenAITool[],
  pendingTools: Map<string, ParkedToolCall>,
  onPark: () => void,
): Promise<Record<string, unknown> | undefined> {
  try {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    const { z } = await import("zod");
    const createSdkMcpServer = (sdk as { createSdkMcpServer?: Function })
      .createSdkMcpServer;
    const toolFactory = (sdk as { tool?: Function }).tool;
    if (typeof createSdkMcpServer !== "function" || typeof toolFactory !== "function") {
      log.warn("[opencode-claude] SDK MCP helpers unavailable; OpenCode tools disabled");
      return undefined;
    }

    // Full conversion of an OpenCode JSON Schema (descriptions, enums,
    // nested item shapes and required fields) into a zod shape. The SDK
    // re-serialises shapes with its own bundled zod, and one construct it
    // cannot handle makes tools/list fail for EVERY tool, so each converted
    // shape is dry-run through a throwaway SDK server and used only if it
    // lists cleanly. Returns null to fall back to the primitive mapping.
    const faithfulShape = async (
      schema: Record<string, unknown> | undefined,
    ): Promise<Record<string, unknown> | null> => {
      const fromJSONSchema = (z as { fromJSONSchema?: Function }).fromJSONSchema;
      if (!schema || typeof schema !== "object" || typeof fromJSONSchema !== "function") {
        return null;
      }
      const key = JSON.stringify(schema);
      if (faithfulShapeCache.has(key)) return faithfulShapeCache.get(key) ?? null;
      let verified: Record<string, unknown> | null = null;
      try {
        const full = fromJSONSchema(schema) as { shape?: unknown };
        if (full?.shape && typeof full.shape === "object") {
          const shape = full.shape as Record<string, unknown>;
          const probe = createSdkMcpServer({
            name: "probe",
            tools: [toolFactory("probe", "probe", shape, async () => ({ content: [] }))],
          }) as { instance?: any };
          const handlers =
            probe.instance?.server?._requestHandlers ??
            probe.instance?._requestHandlers;
          const list = handlers?.get?.("tools/list");
          if (typeof list === "function") {
            const listed = await list({ method: "tools/list", params: {} }, {});
            if (Array.isArray(listed?.tools) && listed.tools.length === 1) {
              verified = shape;
            }
          }
        }
      } catch {
        verified = null;
      }
      faithfulShapeCache.set(key, verified);
      return verified;
    };

    const jsonSchemaToZodShape = (
      schema: Record<string, unknown> | undefined,
    ): Record<string, unknown> => {
      const props =
        schema &&
        typeof schema === "object" &&
        schema.properties &&
        typeof schema.properties === "object"
          ? (schema.properties as Record<string, unknown>)
          : {};
      const required = new Set(
        Array.isArray(schema?.required)
          ? schema!.required.filter((x): x is string => typeof x === "string")
          : [],
      );
      const shape: Record<string, unknown> = {};
      for (const [key, prop] of Object.entries(props)) {
        const type =
          prop && typeof prop === "object"
            ? (prop as { type?: unknown }).type
            : undefined;
        let field: unknown = z.any();
        if (type === "string") field = z.string();
        else if (type === "number" || type === "integer") field = z.number();
        else if (type === "boolean") field = z.boolean();
        else if (type === "array") field = z.array(z.any());
        // Not z.record: the SDK converts shapes with its own bundled zod, and
        // a newer plugin-side zod (4.5.x) emits records through a processor
        // the older converter cannot run, which breaks tools/list for every
        // tool (#12). An open object serialises identically across versions.
        else if (type === "object") field = z.object({}).catchall(z.any());
        if (!required.has(key)) {
          field = (field as { optional: () => unknown }).optional();
        }
        shape[key] = field;
      }
      return shape;
    };

    const shapes = new Map<OpenAITool, Record<string, unknown>>();
    for (const t of tools) {
      if (!t.function?.name) continue;
      const params = t.function?.parameters as
        | Record<string, unknown>
        | undefined;
      shapes.set(t, (await faithfulShape(params)) ?? jsonSchemaToZodShape(params));
    }

    const mcpTools = tools
      .map((t) => {
        const name = t.function?.name;
        if (!name) return null;
        const description = fitToolDescription(t.function?.description || name);
        const shape = shapes.get(t) ?? {};
        const extras: Record<string, unknown> = { alwaysLoad: true };
        if (PARALLEL_SAFE_TOOLS.has(name)) {
          extras.annotations = { readOnlyHint: true };
        }
        return toolFactory(
          name,
          description,
          shape,
          async (args: Record<string, unknown>) => {
            const id = `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
            const pending: ParkedToolCall = {
              id,
              name,
              arguments: JSON.stringify(args ?? {}),
              resolve: () => {},
              reject: () => {},
            };
            const resultPromise = new Promise<McpToolResultContent[]>(
              (resolve, reject) => {
                pending.resolve = resolve;
                pending.reject = reject;
              },
            );
            // Register before notifying so the stream consumer sees the tool.
            pendingTools.set(id, pending);
            onPark();
            const result = await resultPromise;
            return {
              content: result,
            };
          },
          extras,
        );
      })
      .filter(Boolean);

    const server = createSdkMcpServer({
      name: "opencode",
      alwaysLoad: true,
      tools: mcpTools,
    });

    // Decode string-encoded arguments before the SDK validates them. Not in
    // the zod shape: the SDK lists a preprocessed field as optional.
    const properties = new Map(tools.map((t) => [t.function?.name, t.function?.parameters?.properties]));
    const handlers = (server as { instance?: { server?: { _requestHandlers?: Map<string, Function> } } })
      .instance?.server?._requestHandlers;
    const callTool = handlers?.get("tools/call");
    if (handlers && callTool) {
      handlers.set("tools/call", (request: { params?: { name?: string; arguments?: unknown } }, extra: unknown) => {
        const props = properties.get(request.params?.name);
        const args = request.params?.arguments;
        if (!props || typeof props !== "object" || !args || typeof args !== "object") {
          return callTool(request, extra);
        }
        const decoded = Object.fromEntries(
          Object.entries(args).map(([key, value]) => [key, coerceStringArgument(value, (props as Record<string, unknown>)[key])]),
        );
        return callTool({ ...request, params: { ...request.params, arguments: decoded } }, extra);
      });
    }

    return { opencode: server };
  } catch (err) {
    log.warn(
      "[opencode-claude] failed to build OpenCode MCP server",
      err instanceof Error ? err.message : err,
    );
    return undefined;
  }
}
