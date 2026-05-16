/**
 * Direct upstream handler for API-key-based upstreams (OpenAI, Anthropic,
 * Gemini, custom). This path has no account pool management, no session
 * affinity, and no retry logic; it only proxies the translated request and
 * translates the upstream response back to the route format.
 */

import type { StatusCode } from "hono/utils/http-status";
import { stream } from "hono/streaming";
import { CodexApiError } from "../../proxy/codex-api.js";
import { randomUUID } from "crypto";
import { enqueueLogEntry } from "../../logs/entry.js";
import { recordStreamCloseEvent } from "../../logs/stream-close-event.js";
import { streamResponse } from "./response-processor.js";
import { toErrorStatus } from "./proxy-error-handler.js";
import type { HandleDirectRequestOptions } from "./proxy-handler-types.js";
import type { UpstreamAdapter } from "../../proxy/upstream-adapter.js";
import { canReturnStreamError, streamErrorResponse } from "./stream-error-response.js";
import { buildDirectUpstreamStatsTarget, recordDirectUpstreamUsage } from "./direct-upstream-usage.js";
import type { UsageInfo } from "../../translation/codex-event-extractor.js";
import { isModelNotSupportedError } from "../../proxy/error-classification.js";

export async function handleDirectRequest(options: HandleDirectRequestOptions): Promise<Response> {
  const { c, upstream, req, fmt } = options;
  const upstreamCandidates = options.upstreamCandidates && options.upstreamCandidates.length > 0
    ? options.upstreamCandidates
    : [{ adapter: upstream }];
  const statsTarget = buildDirectUpstreamStatsTarget(
    upstream.tag,
    options.upstreamEntry ?? upstreamCandidates[0]?.entry,
  );
  const abortController = new AbortController();
  c.req.raw.signal.addEventListener("abort", () => abortController.abort(), { once: true });

  const requestId = c.get("requestId") ?? randomUUID().slice(0, 8);
  let rawResponse: Response;
  let activeUpstream = upstream;
  try {
    const directResult = await createDirectUpstreamResponse({
      candidates: upstreamCandidates,
      request: req,
      signal: abortController.signal,
      requestId,
    });
    rawResponse = directResult.response;
    activeUpstream = directResult.upstream;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Upstream request failed";
    const status = err instanceof CodexApiError ? err.status : 502;
    enqueueLogEntry({
      requestId,
      direction: "egress",
      method: "POST",
      path: "/v1/responses",
      model: req.model,
      provider: activeUpstream.tag,
      status,
      latencyMs: 0,
      stream: req.isStreaming,
      error: msg,
      request: {
        model: req.codexRequest.model,
        stream: req.codexRequest.stream,
      },
    });
    if (err instanceof CodexApiError) {
      const code = toErrorStatus(err.status) as StatusCode;
      if (canReturnStreamError(req, fmt)) {
        return streamErrorResponse(c, fmt, code, err.message);
      }
      c.status(code);
      // For API-key upstreams, forward the raw upstream error body transparently.
      try {
        const parsed: unknown = JSON.parse(err.body);
        if (parsed && typeof parsed === "object") {
          return c.json(parsed);
        }
      } catch { /* non-JSON body: fall through */ }
      if (code === 429) {
        return c.json(fmt.format429(err.message));
      }
      return c.json(fmt.formatError(code, err.message));
    }
    if (canReturnStreamError(req, fmt)) {
      return streamErrorResponse(c, fmt, 502, msg);
    }
    c.status(502);
    return c.json(fmt.formatError(502, msg));
  }

  if (req.isStreaming) {
    c.header("Content-Type", "text/event-stream");
    c.header("Cache-Control", "no-cache");
    c.header("Connection", "keep-alive");

    return stream(c, async (s) => {
      let usageInfo: UsageInfo | undefined;
      s.onAbort(() => {
        console.warn(`[stream-client-abort] rid=${requestId.slice(0, 8)} tag=${fmt.tag} model=${req.model}`);
        recordStreamCloseEvent({
          kind: "client-abort",
          requestId,
          tag: fmt.tag,
          provider: activeUpstream.tag,
          path: "/v1/responses",
          model: req.model,
        });
        abortController.abort();
      });
      await streamResponse({
        writer: s,
        api: upstream,
        response: rawResponse,
        model: req.model,
        adapter: fmt,
        onUsage: (u) => {
          usageInfo = u;
        },
        tupleSchema: req.tupleSchema,
        onResponseId: () => {},
        diagnostics: {
          requestId: requestId.slice(0, 8),
          tag: fmt.tag,
          provider: activeUpstream.tag,
          path: "/v1/responses",
          abortSignal: abortController.signal,
        },
      });
      if (usageInfo) {
        recordDirectUpstreamUsage(statsTarget, usageInfo);
      }
    });
  }

  try {
    const result = await fmt.collectTranslator({
      api: activeUpstream,
      response: rawResponse,
      model: req.model,
      tupleSchema: req.tupleSchema,
    });
    recordDirectUpstreamUsage(statsTarget, result.usage);
    return c.json(result.response);
  } catch (err) {
    abortController.abort();
    const msg = err instanceof Error ? err.message : "Failed to collect upstream response";
    const code = toErrorStatus(0) as StatusCode;
    c.status(code);
    return c.json(fmt.formatError(code, msg));
  }
}

async function createDirectUpstreamResponse(options: {
  candidates: NonNullable<HandleDirectRequestOptions["upstreamCandidates"]>;
  request: HandleDirectRequestOptions["req"];
  signal: AbortSignal;
  requestId: string;
}): Promise<{ response: Response; upstream: UpstreamAdapter }> {
  const { candidates, request, signal, requestId } = options;
  let lastError: unknown;

  for (const candidate of candidates) {
    const resolvedModel = candidate.resolvedModel?.trim() || request.codexRequest.model;
    const candidateRequest = resolvedModel === request.codexRequest.model
      ? request.codexRequest
      : { ...request.codexRequest, model: resolvedModel };
    const maxRetries = candidate.entry?.maxRetries ?? 0;
    const modelFallbacks = buildModelFallbacks(candidate.entry, resolvedModel);

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const fallbackModel = modelFallbacks[attempt];
      const effectiveRequest = fallbackModel && fallbackModel !== candidateRequest.model
        ? { ...candidateRequest, model: fallbackModel }
        : candidateRequest;
      const startMs = Date.now();
      try {
        const response = await candidate.adapter.createResponse(effectiveRequest, signal);
        enqueueLogEntry({
          requestId,
          direction: "egress",
          method: "POST",
          path: "/v1/responses",
          model: request.model,
          provider: candidate.adapter.tag,
          status: response.status,
          latencyMs: Date.now() - startMs,
          stream: request.isStreaming,
          request: {
            model: effectiveRequest.model,
            stream: request.codexRequest.stream,
          },
        });
        return { response, upstream: candidate.adapter };
      } catch (error) {
        lastError = error;
        const retryable = isRetryableDirectUpstreamError(error);
        enqueueLogEntry({
          requestId,
          direction: "egress",
          method: "POST",
          path: "/v1/responses",
          model: request.model,
          provider: candidate.adapter.tag,
          status: error instanceof CodexApiError ? error.status : 502,
          latencyMs: Date.now() - startMs,
          stream: request.isStreaming,
          error: error instanceof Error ? error.message : String(error),
          request: {
            model: effectiveRequest.model,
            stream: request.codexRequest.stream,
          },
        });
        if (error instanceof CodexApiError && isModelNotSupportedError(error) && fallbackModel) {
          if (attempt >= modelFallbacks.length - 1) throw error;
          console.warn(
            `[Direct] Upstream ${candidate.adapter.tag} model fallback ${attempt + 1}/${modelFallbacks.length - 1} ` +
            `for requested=${request.model} from=${effectiveRequest.model} to=${modelFallbacks[attempt + 1]}`,
          );
          continue;
        }
        if (!retryable) throw error;
        if (attempt >= maxRetries) break;
        console.warn(
          `[Direct] Upstream ${candidate.adapter.tag} retry ${attempt + 1}/${maxRetries} for model=${request.model}`,
        );
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Upstream request failed");
}

function isRetryableDirectUpstreamError(error: unknown): boolean {
  if (!(error instanceof Error)) return true;
  if (!(error instanceof CodexApiError)) return true;
  return error.status === 408 || error.status === 409 || error.status === 429 || error.status >= 500;
}

function buildModelFallbacks(entry: { model?: string; models?: string[] } | undefined, resolvedModel: string): string[] {
  const ordered = [
    resolvedModel.trim(),
    entry?.model?.trim() ?? "",
    ...(entry?.models ?? []).map((model: string) => model.trim()),
  ].filter(Boolean);
  return [...new Set(ordered)];
}
