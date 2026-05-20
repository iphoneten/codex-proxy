/**
 * Adapter factory — creates UpstreamAdapter instances from ApiKeyEntry.
 * Used by UpstreamRouter for dynamic API key pool entries.
 */

import type { UpstreamAdapter } from "./upstream-adapter.js";
import type { ApiKeyEntry } from "../auth/api-key-pool.js";
import { OpenAIUpstream } from "./openai-upstream.js";
import { AnthropicUpstream } from "./anthropic-upstream.js";
import { GeminiUpstream } from "./gemini-upstream.js";

export function createAdapterForEntry(entry: ApiKeyEntry): UpstreamAdapter {
  switch (entry.protocol) {
    case "anthropic":
      return new AnthropicUpstream(entry.apiKey, entry.baseUrl);
    case "gemini":
      return new GeminiUpstream(entry.apiKey, entry.baseUrl);
    case "openai":
    default: {
      const tag = entry.provider === "custom" ? "custom" : entry.provider;
      return new OpenAIUpstream(tag, entry.apiKey, entry.baseUrl, !!entry.supportsResponsesApi);
    }
  }
}
