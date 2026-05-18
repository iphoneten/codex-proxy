import type { UsageInfo } from "../../translation/codex-event-extractor.js";
import { patchLogEntryByRequestId } from "../../logs/entry.js";

export function enrichEgressLogUsage(options: {
  requestId: string;
  model?: string | null;
  provider?: string | null;
  upstreamName?: string | null;
  usage: UsageInfo | undefined;
}): void {
  const { requestId, model, provider, upstreamName, usage } = options;
  if (!usage) return;
  patchLogEntryByRequestId(requestId, "egress", {
    ...(model !== undefined ? { model } : {}),
    ...(provider !== undefined ? { provider } : {}),
    ...(upstreamName !== undefined ? { upstreamName } : {}),
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cachedTokens: usage.cached_tokens ?? null,
    reasoningTokens: usage.reasoning_tokens ?? null,
  });
}
