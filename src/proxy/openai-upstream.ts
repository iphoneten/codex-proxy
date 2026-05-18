/**
 * OpenAIUpstream — UpstreamAdapter implementation for OpenAI API
 * (and OpenAI-compatible third-party providers: Groq, DeepSeek, Together, etc.)
 *
 * createResponse(): Translates CodexResponsesRequest → OpenAI chat completions,
 *                   makes HTTP call, returns raw Response.
 * parseStream():    Normalizes OpenAI SSE chunks → CodexSSEEvent format.
 */

import { randomUUID } from "crypto";
import type { UpstreamAdapter } from "./upstream-adapter.js";
import type { CodexResponsesRequest, CodexSSEEvent } from "./codex-types.js";
import { CodexApiError } from "./codex-types.js";
import { parseSSEStream } from "./codex-sse.js";
import { translateCodexToOpenAIRequest } from "../translation/codex-request-to-openai.js";
import { withFetchDispatcher } from "./fetch-dispatcher.js";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function extractModelId(model: string): string {
  const colon = model.indexOf(":");
  return colon > 0 ? model.slice(colon + 1) : model;
}

function buildUsageDetails(opts: {
  cachedTokens?: number;
  reasoningTokens?: number;
}): {
  input_tokens_details?: { cached_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
} {
  const input_tokens_details =
    opts.cachedTokens != null
      ? { cached_tokens: opts.cachedTokens }
      : undefined;
  const output_tokens_details =
    opts.reasoningTokens != null
      ? { reasoning_tokens: opts.reasoningTokens }
      : undefined;

  return {
    ...(input_tokens_details ? { input_tokens_details } : {}),
    ...(output_tokens_details ? { output_tokens_details } : {}),
  };
}

function extractReasoningDelta(delta: Record<string, unknown>): string | null {
  if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
    return delta.reasoning_content;
  }
  if (typeof delta.reasoning === "string" && delta.reasoning.length > 0) {
    return delta.reasoning;
  }
  const reasoning = isRecord(delta.reasoning) ? delta.reasoning : null;
  if (!reasoning) return null;
  if (typeof reasoning.content === "string" && reasoning.content.length > 0) {
    return reasoning.content;
  }
  if (typeof reasoning.text === "string" && reasoning.text.length > 0) {
    return reasoning.text;
  }
  return null;
}

export class OpenAIUpstream implements UpstreamAdapter {
  readonly tag: string;
  private apiKey: string;
  private baseUrl: string;

  constructor(tag: string, apiKey: string, baseUrl = "https://api.openai.com/v1") {
    this.tag = tag;
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async createResponse(
    req: CodexResponsesRequest,
    signal: AbortSignal,
  ): Promise<Response> {
    const modelId = extractModelId(req.model);
    const body = translateCodexToOpenAIRequest(req, modelId, req.stream);

    const response = await fetch(`${this.baseUrl}/chat/completions`, withFetchDispatcher({
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
      },
      body: JSON.stringify(body),
      signal,
    }));

    if (!response.ok) {
      const errorText = await response.text().catch(() => `HTTP ${response.status}`);
      throw new CodexApiError(response.status, errorText);
    }

    return response;
  }

  async *parseStream(response: Response): AsyncGenerator<CodexSSEEvent> {
    let responseId = `openai-${randomUUID().slice(0, 8)}`;
    let sentCreated = false;
    let finishReason: string | null = null;
    const usage = { input_tokens: 0, output_tokens: 0, cached_tokens: 0 };

    // Maps tool call index → { id, name, argBuffer }
    const toolCalls = new Map<
      number,
      { id: string; name: string; argBuffer: string }
    >();

    for await (const raw of parseSSEStream(response)) {
      // OpenAI SSE has no `event:` field — data is the chunk object
      if (!isRecord(raw.data)) continue;

      const chunk = raw.data;

      // Emit response.created once
      if (!sentCreated) {
        const id = typeof chunk.id === "string" ? chunk.id : responseId;
        responseId = id;
        yield {
          event: "response.created",
          data: { response: { id } },
        };
        sentCreated = true;
      }

      // Usage (arrives in last chunk when stream_options.include_usage = true)
      if (isRecord(chunk.usage)) {
        const u = chunk.usage;
        usage.input_tokens = typeof u.prompt_tokens === "number" ? u.prompt_tokens : 0;
        usage.output_tokens = typeof u.completion_tokens === "number" ? u.completion_tokens : 0;
        // OpenAI nests cache hits under prompt_tokens_details.cached_tokens.
        const ptd = isRecord(u.prompt_tokens_details) ? u.prompt_tokens_details : null;
        if (ptd && typeof ptd.cached_tokens === "number") {
          usage.cached_tokens = ptd.cached_tokens;
        }
      }

      const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
      for (const choice of choices) {
        if (!isRecord(choice)) continue;
        const delta = isRecord(choice.delta) ? choice.delta : null;
        if (!delta) continue;

        if (typeof choice.finish_reason === "string") {
          finishReason = choice.finish_reason;
        }

        const reasoningDelta = extractReasoningDelta(delta);
        if (reasoningDelta) {
          yield {
            event: "response.reasoning_summary_text.delta",
            data: { delta: reasoningDelta },
          };
        }

        // Text delta
        if (typeof delta.content === "string" && delta.content.length > 0) {
          yield {
            event: "response.output_text.delta",
            data: { delta: delta.content },
          };
        }

        // Tool call deltas
        const deltaToolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
        for (const tc of deltaToolCalls) {
          if (!isRecord(tc)) continue;
          const index = typeof tc.index === "number" ? tc.index : 0;
          const fn = isRecord(tc.function) ? tc.function : null;

          if (!toolCalls.has(index)) {
            // First chunk for this tool call — has id and name
            const id = typeof tc.id === "string" ? tc.id : `call_${randomUUID().slice(0, 8)}`;
            const name = fn && typeof fn.name === "string" ? fn.name : "";
            toolCalls.set(index, { id, name, argBuffer: "" });

            yield {
              event: "response.output_item.added",
              data: {
                output_index: index,
                item: {
                  type: "function_call",
                  id: `item_${index}`,
                  call_id: id,
                  name,
                },
              },
            };
          }

          if (fn && typeof fn.arguments === "string" && fn.arguments.length > 0) {
            const info = toolCalls.get(index)!;
            info.argBuffer += fn.arguments;
            yield {
              event: "response.function_call_arguments.delta",
              data: { call_id: info.id, delta: fn.arguments, output_index: index },
            };
          }
        }
      }
    }

    // Emit function_call_arguments.done for each completed tool call
    for (const [index, info] of toolCalls) {
      yield {
        event: "response.function_call_arguments.done",
        data: { call_id: info.id, name: info.name, arguments: info.argBuffer, output_index: index },
      };
      yield {
        event: "response.output_item.done",
        data: {
          output_index: index,
          item: {
            type: "function_call",
            id: `item_${index}`,
            call_id: info.id,
            name: info.name,
            arguments: info.argBuffer,
            status: "completed",
          },
        },
      };
    }

    // Emit response.completed with usage
    const completedReason = finishReason ?? "stop";
    yield {
      event: "response.completed",
      data: {
        response: {
          id: responseId,
          status: completedReason === "stop" || completedReason === "tool_calls" ? "completed" : completedReason,
          usage: {
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            ...buildUsageDetails({ cachedTokens: usage.cached_tokens > 0 ? usage.cached_tokens : undefined }),
          },
        },
      },
    };
  }
}
