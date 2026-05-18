/**
 * Anthropic Messages API route handler.
 * POST /v1/messages — compatible with Claude Code CLI and other Anthropic clients.
 */

import { Hono } from "hono";
import type { StatusCode } from "hono/utils/http-status";
import { AnthropicMessagesRequestSchema } from "../types/anthropic.js";
import type { AnthropicErrorBody, AnthropicErrorType } from "../types/anthropic.js";
import type { AccountPool } from "../auth/account-pool.js";
import type { CookieJar } from "../proxy/cookie-jar.js";
import type { ProxyPool } from "../proxy/proxy-pool.js";
import { translateAnthropicToCodexRequest } from "../translation/anthropic-to-codex.js";
import {
  streamCodexToAnthropic,
  collectCodexToAnthropicResponse,
} from "../translation/codex-to-anthropic.js";
import { getConfig } from "../config.js";
import { parseModelName, buildDisplayModelName } from "../models/model-store.js";
import { enqueueLogEntry } from "../logs/entry.js";
import { getRealClientIp } from "../utils/get-real-client-ip.js";
import { randomUUID } from "crypto";
import {
  handleProxyRequest,
} from "./shared/proxy-handler.js";
import { handleDirectRequest } from "./shared/direct-request-handler.js";
import type { FormatAdapter } from "./shared/proxy-handler-types.js";
import { extractAnthropicClientConversationId } from "./shared/anthropic-session-id.js";
import type { UpstreamRouter } from "../proxy/upstream-router.js";
import { summarizeRequestForLog } from "../logs/request-summary.js";

function resolveDirectCandidatesSafe(upstreamRouter: UpstreamRouter | undefined, model: string) {
  const maybe = upstreamRouter as UpstreamRouter & {
    resolveDirectCandidates?: (requestedModel: string) => Array<{ adapter: unknown; entry?: unknown }>;
  };
  return typeof maybe?.resolveDirectCandidates === "function"
    ? maybe.resolveDirectCandidates(model)
    : undefined;
}

function makeError(
  type: AnthropicErrorType,
  message: string,
): AnthropicErrorBody {
  return { type: "error", error: { type, message } };
}

function makeAnthropicFormat(wantThinking: boolean): FormatAdapter {
  return {
    tag: "Messages",
    noAccountStatus: 529 as StatusCode,
    formatNoAccount: () =>
      makeError(
        "overloaded_error",
        "No available accounts. All accounts are expired or rate-limited.",
      ),
    format429: (msg) => makeError("rate_limit_error", msg),
    formatError: (_status, msg) => makeError("api_error", msg),
    formatStreamError: (status, msg) => `event: error\ndata: ${JSON.stringify(
      status === 429 ? makeError("rate_limit_error", msg) : makeError("api_error", msg),
    )}\n\n`,
    streamTranslator: ({
      api,
      response,
      model,
      onUsage,
      onResponseId,
      onResponseCompleted,
      usageHint,
      onResponseMetadata,
    }) =>
      streamCodexToAnthropic(api, response, model, onUsage, onResponseId, wantThinking, usageHint, onResponseMetadata, onResponseCompleted),
    collectTranslator: ({
      api,
      response,
      model,
      usageHint,
      onResponseMetadata,
    }) =>
      collectCodexToAnthropicResponse(api, response, model, wantThinking, usageHint, onResponseMetadata),
  };
}

function maskProxyApiKey(key: string | null | undefined): string {
  if (!key) return "disabled";
  if (key.length <= 4) return key;
  if (key.length <= 8) return `${key.slice(0, 1)}***${key.slice(-1)}`;
  return `${key.slice(0, 3)}***${key.slice(-2)}`;
}

export function createMessagesRoutes(
  accountPool: AccountPool,
  cookieJar?: CookieJar,
  proxyPool?: ProxyPool,
  upstreamRouter?: UpstreamRouter,
): Hono {
  const app = new Hono();

  app.post("/v1/messages", async (c) => {
    // Parse request
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      c.status(400);
      return c.json(
        makeError("invalid_request_error", "Invalid JSON in request body"),
      );
    }
    const parsed = AnthropicMessagesRequestSchema.safeParse(body);
    if (!parsed.success) {
      c.status(400);
      return c.json(
        makeError("invalid_request_error", `Invalid request: ${parsed.error.message}`),
      );
    }
    const req = parsed.data;

    const directCandidates = resolveDirectCandidatesSafe(upstreamRouter, req.model);
    const routeMatch = upstreamRouter?.resolveMatch(req.model);
    const isDirectRouteMatch = routeMatch?.kind === "api-key" || routeMatch?.kind === "adapter";
    const allowUnauthenticated =
      !!directCandidates?.length ||
      isDirectRouteMatch;

    // Auth check
    if (!allowUnauthenticated && !accountPool.isAuthenticated()) {
      c.status(401);
      console.warn(
        `[Messages] proxy key check failed: expected=${maskProxyApiKey(getConfig().server.proxy_api_key)} ` +
        `provided=${maskProxyApiKey(c.req.header("Authorization")?.replace("Bearer ", ""))}`,
      );
      return c.json(
        makeError("authentication_error", "Not authenticated. Please login first at /"),
      );
    }

    // Optional proxy API key check (x-api-key or Bearer token)
    const config = getConfig();
    if (config.server.proxy_api_key) {
      const xApiKey = c.req.header("x-api-key");
      const authHeader = c.req.header("Authorization");
      const bearerKey = authHeader?.replace("Bearer ", "");
      const providedKey = xApiKey ?? bearerKey;

      if (!providedKey || !accountPool.validateProxyApiKey(providedKey)) {
        c.status(401);
        console.warn(
          `[Messages] proxy key check failed: expected=${maskProxyApiKey(config.server.proxy_api_key)} ` +
          `provided=${maskProxyApiKey(providedKey)}`,
        );
        return c.json(makeError("authentication_error", "Invalid API key"));
      }
    }

    const clientConversationId = extractAnthropicClientConversationId(
      req,
      c.req.header("x-claude-code-session-id"),
    );

    const codexRequest = translateAnthropicToCodexRequest(req, undefined, {
      injectHostedWebSearch: !allowUnauthenticated,
      mapClaudeCodeWebSearch: !allowUnauthenticated && clientConversationId !== null,
    });
    if (!allowUnauthenticated) {
      codexRequest.useWebSocket = true;
    }
    const wantThinking = req.thinking?.type === "enabled" || req.thinking?.type === "adaptive";
    const proxyReq = {
      codexRequest,
      model: buildDisplayModelName(parseModelName(req.model)),
      isStreaming: req.stream,
      clientConversationId: clientConversationId ?? undefined,
    };
    const fmt = makeAnthropicFormat(wantThinking);
    const canFallbackToAccountPool = accountPool.isAuthenticated();
    const fallbackToAccountPool = () =>
      handleProxyRequest({ c, accountPool, cookieJar, req: proxyReq, fmt, proxyPool });

    const requestId = c.get("requestId") ?? randomUUID().slice(0, 8);
    enqueueLogEntry({
      requestId,
      direction: "ingress",
      method: c.req.method,
      path: c.req.path,
      model: req.model,
      stream: !!req.stream,
      request: summarizeRequestForLog("messages", req, {
        ip: getRealClientIp(c, getConfig()?.server?.trust_proxy ?? false),
        headers: Object.fromEntries(c.req.raw.headers.entries()),
      }),
    });

    if (isDirectRouteMatch || directCandidates?.length) {
      const directPrimary = directCandidates?.[0];
      const directModel = isDirectRouteMatch
        ? (routeMatch.resolvedModel ?? req.model)
        : (directPrimary?.resolvedModel ?? req.model);
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
        fmt,
        fallbackToAccountPool: canFallbackToAccountPool ? fallbackToAccountPool : undefined,
      });
    }

    return handleProxyRequest({ c, accountPool, cookieJar, req: proxyReq, fmt, proxyPool });
  });

  return app;
}
