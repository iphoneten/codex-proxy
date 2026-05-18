/**
 * Google Gemini API route handler.
 * POST /v1beta/models/{model}:generateContent — non-streaming
 * POST /v1beta/models/{model}:streamGenerateContent — streaming
 */

import { Hono } from "hono";
import type { StatusCode } from "hono/utils/http-status";
import type { GeminiErrorResponse } from "../types/gemini.js";
import { GEMINI_STATUS_MAP } from "../types/gemini.js";
import { GeminiGenerateContentRequestSchema } from "../types/gemini.js";
import type { AccountPool } from "../auth/account-pool.js";
import type { CookieJar } from "../proxy/cookie-jar.js";
import type { ProxyPool } from "../proxy/proxy-pool.js";
import {
  translateGeminiToCodexRequest,
} from "../translation/gemini-to-codex.js";
import {
  streamCodexToGemini,
  collectCodexToGeminiResponse,
} from "../translation/codex-to-gemini.js";
import { getConfig } from "../config.js";
import { getModelCatalog } from "../models/model-store.js";
import {
  handleProxyRequest,
} from "./shared/proxy-handler.js";
import { handleDirectRequest } from "./shared/direct-request-handler.js";
import type { FormatAdapter, ProxyRequest } from "./shared/proxy-handler-types.js";
import type { UpstreamRouter } from "../proxy/upstream-router.js";

function resolveDirectCandidatesSafe(upstreamRouter: UpstreamRouter | undefined, model: string) {
  const maybe = upstreamRouter as UpstreamRouter & {
    resolveDirectCandidates?: (requestedModel: string) => Array<{ adapter: unknown; entry?: unknown }>;
  };
  return typeof maybe?.resolveDirectCandidates === "function"
    ? maybe.resolveDirectCandidates(model)
    : undefined;
}

function makeError(
  code: number,
  message: string,
  status?: string,
): GeminiErrorResponse {
  return {
    error: {
      code,
      message,
      status: status ?? GEMINI_STATUS_MAP[code] ?? "INTERNAL",
    },
  };
}

/**
 * Parse model name and action from the URL param.
 * e.g. "gemini-2.5-pro:generateContent" → { model: "gemini-2.5-pro", action: "generateContent" }
 */
function parseModelAction(param: string): {
  model: string;
  action: string;
} | null {
  const lastColon = param.lastIndexOf(":");
  if (lastColon <= 0) return null;
  return {
    model: param.slice(0, lastColon),
    action: param.slice(lastColon + 1),
  };
}

const GEMINI_FORMAT: FormatAdapter = {
  tag: "Gemini",
  noAccountStatus: 503,
  formatNoAccount: () =>
    makeError(
      503,
      "No available accounts. All accounts are expired or rate-limited.",
      "UNAVAILABLE",
    ),
  format429: (msg) => makeError(429, msg, "RESOURCE_EXHAUSTED"),
  formatError: (status, msg) => makeError(status, msg),
  formatStreamError: (status, msg) => `data: ${JSON.stringify(
    status === 429 ? makeError(429, msg, "RESOURCE_EXHAUSTED") : makeError(status, msg),
  )}\n\n`,
  streamTranslator: ({ api, response, model, onUsage, onResponseId, onResponseCompleted, tupleSchema }) =>
    streamCodexToGemini(api, response, model, onUsage, onResponseId, tupleSchema, onResponseCompleted),
  collectTranslator: ({ api, response, model, tupleSchema }) =>
    collectCodexToGeminiResponse(api, response, model, tupleSchema),
};

function maskProxyApiKey(key: string | null | undefined): string {
  if (!key) return "disabled";
  if (key.length <= 4) return key;
  if (key.length <= 8) return `${key.slice(0, 1)}***${key.slice(-1)}`;
  return `${key.slice(0, 3)}***${key.slice(-2)}`;
}

export function createGeminiRoutes(
  accountPool: AccountPool,
  cookieJar?: CookieJar,
  proxyPool?: ProxyPool,
  upstreamRouter?: UpstreamRouter,
): Hono {
  const app = new Hono();

  // Handle both generateContent and streamGenerateContent
  app.post("/v1beta/models/:modelAction", async (c) => {
    const modelActionParam = c.req.param("modelAction");
    const parsed = parseModelAction(modelActionParam);

    if (
      !parsed ||
      (parsed.action !== "generateContent" &&
        parsed.action !== "streamGenerateContent")
    ) {
      c.status(400);
      return c.json(
        makeError(
          400,
          `Invalid action. Expected :generateContent or :streamGenerateContent, got: ${modelActionParam}`,
        ),
      );
    }

    const { model: geminiModel, action } = parsed;
    const isStreaming =
      action === "streamGenerateContent" ||
      c.req.query("alt") === "sse";

    // Parse request
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      c.status(400);
      return c.json(makeError(400, "Invalid JSON in request body"));
    }
    const validationResult = GeminiGenerateContentRequestSchema.safeParse(body);
    if (!validationResult.success) {
      c.status(400);
      return c.json(
        makeError(400, `Invalid request: ${validationResult.error.message}`),
      );
    }
    const req = validationResult.data;

    const directCandidates = resolveDirectCandidatesSafe(upstreamRouter, geminiModel);
    const routeMatch = upstreamRouter?.resolveMatch(geminiModel);
    const isDirectRouteMatch = routeMatch?.kind === "api-key" || routeMatch?.kind === "adapter";
    const allowUnauthenticated =
      !!directCandidates?.length ||
      isDirectRouteMatch;

    // Auth check
    if (!allowUnauthenticated && !accountPool.isAuthenticated()) {
      c.status(401);
      console.warn(
        `[Gemini] proxy key check failed: expected=${maskProxyApiKey(getConfig().server.proxy_api_key)} ` +
        `provided=${maskProxyApiKey(c.req.header("Authorization")?.replace("Bearer ", ""))}`,
      );
      return c.json(
        makeError(401, "Not authenticated. Please login first at /"),
      );
    }

    // API key check: query param ?key= or header x-goog-api-key
    const config = getConfig();
    if (config.server.proxy_api_key) {
      const queryKey = c.req.query("key");
      const headerKey = c.req.header("x-goog-api-key");
      const authHeader = c.req.header("Authorization");
      const bearerKey = authHeader?.replace("Bearer ", "");
      const providedKey = queryKey ?? headerKey ?? bearerKey;

      if (!providedKey || !accountPool.validateProxyApiKey(providedKey)) {
        c.status(401);
        console.warn(
          `[Gemini] proxy key check failed: expected=${maskProxyApiKey(config.server.proxy_api_key)} ` +
          `provided=${maskProxyApiKey(providedKey)}`,
        );
        return c.json(makeError(401, "Invalid API key"));
      }
    }

    const { codexRequest, tupleSchema } = translateGeminiToCodexRequest(
      req,
      geminiModel,
    );

    console.log(
      `[Gemini] Model: ${geminiModel} → ${codexRequest.model}`,
    );

    const proxyReq: ProxyRequest = {
      codexRequest,
      model: geminiModel,
      isStreaming,
      clientConversationId: c.req.header("x-conversation-id") || c.req.header("x-session-id"),
      tupleSchema,
    };
    const canFallbackToAccountPool = accountPool.isAuthenticated();
    const fallbackToAccountPool = () =>
      handleProxyRequest({ c, accountPool, cookieJar, req: proxyReq, fmt: GEMINI_FORMAT, proxyPool });

    if (isDirectRouteMatch || directCandidates?.length) {
      const directPrimary = directCandidates?.[0];
      const directModel = isDirectRouteMatch
        ? (routeMatch.resolvedModel ?? geminiModel)
        : (directPrimary!.resolvedModel ?? geminiModel);
      const directReq = {
        ...proxyReq,
        model: directModel,
        codexRequest: { ...codexRequest, model: directModel },
      };
      return handleDirectRequest({
        c,
        upstream: isDirectRouteMatch
          ? routeMatch.adapter
          : directPrimary!.adapter,
        upstreamCandidates: directCandidates,
        upstreamEntry: routeMatch?.kind === "api-key" ? routeMatch.entry : undefined,
        req: directReq,
        fmt: GEMINI_FORMAT,
        fallbackToAccountPool: canFallbackToAccountPool ? fallbackToAccountPool : undefined,
      });
    }

    return handleProxyRequest({ c, accountPool, cookieJar, req: proxyReq, fmt: GEMINI_FORMAT, proxyPool });
  });

  // List available models (Gemini format)
  app.get("/v1beta/models", (c) => {
    const catalog = getModelCatalog();
    const models = catalog.map((m) => ({
      name: `models/${m.id}`,
      displayName: m.displayName,
      description: m.description,
      supportedGenerationMethods: [
        "generateContent",
        "streamGenerateContent",
      ],
    }));

    return c.json({ models });
  });

  return app;
}
