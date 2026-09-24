/**
 * OpenCode V2 plugin: registers the claude-code provider against the local
 * proxy and relays Claude CLI sign-in as an OAuth-shaped integration method.
 * The V1 implementation stays on the default export's `server` (see
 * index.ts); the two APIs share nothing but the proxy and the auth relay.
 */
import {
  Credential,
  Integration,
  Model,
  Plugin,
  Provider,
} from "@opencode/plugin";
import {
  DIRECTORY_HEADER,
  EFFORT_HEADER,
  EFFORT_LEVELS,
  PROVIDER_ID,
  PROXY_TOKEN_HEADER,
  REQUEST_KIND_HEADER,
  SESSION_HEADER,
} from "./constants.js";
import { detectClaudeCode } from "./detect.js";
import { resolveClaudeCli } from "./executable-path.js";
import { log } from "./log.js";
import {
  encodeClaudeModelSelection,
  resolveClaudeModelSelection,
} from "./model-selection.js";
import { getClaudeModels } from "./models.js";
import {
  getClaudeProxyBaseUrl,
  getProxyAuthToken,
  startProxy,
  stopProxy,
} from "./proxy.js";

const AUTH_METHOD_ID = "claude-cli";
const PROVIDER_PACKAGE = "@opencode/ai/providers/openai-compatible";
const CONNECTION_MARKER = "managed-by-claude-code-cli";
const CONNECTION_TTL_MS = 365 * 24 * 60 * 60 * 1_000;

function connectionMarker(): Credential.OAuth {
  return Credential.OAuth.make({
    type: "oauth",
    methodID: Integration.MethodID.make(AUTH_METHOD_ID),
    access: CONNECTION_MARKER,
    refresh: CONNECTION_MARKER,
    expires: Date.now() + CONNECTION_TTL_MS,
  });
}

async function requireLoginSuccess(result: { type: string }) {
  if (result.type !== "success") {
    throw new Error("Claude Code CLI sign-in failed");
  }
  return connectionMarker();
}

async function authorizeWithClaudeCli() {
  const { buildAuthMethods } = await import("./index.js");
  // Presence only: the chosen method's authorize runs the full detection.
  const authorization = await buildAuthMethods(
    (await resolveClaudeCli()) !== null,
    process.cwd(),
  )[0]!.authorize();
  if (authorization.method === "code") {
    return {
      url: authorization.url,
      instructions: authorization.instructions,
      mode: "code" as const,
      callback: async (code: string) =>
        requireLoginSuccess(await authorization.callback(code)),
    };
  }
  return {
    url: authorization.url,
    instructions: authorization.instructions,
    mode: "auto" as const,
    callback: authorization.callback().then(requireLoginSuccess),
  };
}

function toModelInfo(definition: {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  inputWindow?: number;
}): Model.Info {
  return {
    id: Model.ID.make(definition.id),
    modelID: Model.ID.make(definition.id),
    providerID: Provider.ID.make(PROVIDER_ID),
    name: definition.name,
    capabilities: {
      tools: true,
      input: ["text", "image", "pdf"],
      output: ["text"],
    },
    variants: EFFORT_LEVELS.map((effort) => ({
      id: Model.VariantID.make(effort),
    })),
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: {
      context: definition.contextWindow,
      ...(definition.inputWindow ? { input: definition.inputWindow } : {}),
      output: definition.maxTokens,
    },
  };
}

export const setupV2: Plugin.Plugin["setup"] = async (ctx) => {
  await startProxy();
  try {
    await ctx.provider.transform((editor) => {
      editor.add({
        info: {
          id: Provider.ID.make(PROVIDER_ID),
          name: "Claude Code",
          activation: "enabled",
          package: PROVIDER_PACKAGE,
          integrationID: Integration.ID.make(PROVIDER_ID),
          // The proxy secret travels both as the API key and as a header
          // (model.request below): the saved connection-marker credential can
          // take over the Authorization header, the dedicated header cannot.
          settings: {
            apiKey: getProxyAuthToken(),
            baseURL: getClaudeProxyBaseUrl(),
          },
        },
        models: getClaudeModels().map(toModelInfo),
      });
    });

    await ctx.integration.transform((editor) => {
      editor.update(PROVIDER_ID, (integration) => {
        integration.name = "Claude Code";
      });
      editor.method.update({
        integrationID: PROVIDER_ID,
        method: {
          id: AUTH_METHOD_ID,
          type: "oauth",
          label: "Sign in with Claude Code CLI",
        },
        authorize: authorizeWithClaudeCli,
        refresh: async (credential) => {
          if (!(await detectClaudeCode()).loggedIn) {
            throw new Error(
              "Claude Code CLI is not signed in. Run `claude auth login --claudeai`.",
            );
          }
          return { ...credential, expires: Date.now() + CONNECTION_TTL_MS };
        },
        label: () => "Claude Code CLI",
      });
    });

    await ctx.session.hook("model.request", (event) => {
      if (event.model.providerID !== PROVIDER_ID) return;
      event.headers[EFFORT_HEADER] = encodeClaudeModelSelection(
        resolveClaudeModelSelection(event.model.id, event.model.variant),
      );
      event.headers[PROXY_TOKEN_HEADER] = getProxyAuthToken();
      event.headers[SESSION_HEADER] = event.sessionID;
      event.headers[DIRECTORY_HEADER] = ctx.location.directory;
      event.headers[REQUEST_KIND_HEADER] = event.kind;
    });
  } catch (error) {
    await stopProxy();
    throw error;
  }
  return async () => {
    await stopProxy();
    log.info("[opencode-claude] V2 plugin unloaded");
  };
};

export const claudeCodePluginV2 = Plugin.define({
  id: "opencode-claude",
  setup: setupV2,
});
