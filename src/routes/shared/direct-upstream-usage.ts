import type { ApiKeyEntry } from "../../auth/api-key-pool.js";
import type { UsageInfo } from "../../translation/codex-event-extractor.js";
import { getDirectUpstreamUsageStore } from "../../usage/direct-upstream-usage.js";

export interface DirectUpstreamStatsTarget {
  provider: string;
  key: string;
  label: string;
}

export function buildDirectUpstreamStatsTarget(
  upstreamTag: string,
  entry?: ApiKeyEntry,
): DirectUpstreamStatsTarget {
  if (entry) {
    return {
      provider: entry.provider,
      key: `api-key:${entry.id}`,
      label: entry.label?.trim() || `${entry.provider}:${entry.models[0] ?? entry.id}`,
    };
  }
  return {
    provider: upstreamTag,
    key: `adapter:${upstreamTag}`,
    label: upstreamTag,
  };
}

export function recordDirectUpstreamUsage(
  target: DirectUpstreamStatsTarget,
  usage: UsageInfo | undefined,
): void {
  getDirectUpstreamUsageStore().record(target.key, target.provider, target.label, usage);
}
