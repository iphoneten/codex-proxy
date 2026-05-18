/**
 * UpstreamRouter — routes a model name to the appropriate UpstreamAdapter.
 *
 * Priority (highest to lowest):
 *   0. ApiKeyPool entry matching the exact model name
 *   1. Explicit provider prefix: "openai:gpt-4o", "anthropic:claude-3-5-sonnet"
 *   2. Model aliases: { "claude-opus-4-7": "gpt-5.5" }
 *   3. model_routing config table: { "deepseek-chat": "deepseek" }
 *   4. Known Codex model IDs
 *   5. Custom provider `models` list
 *   6. Built-in name pattern rules: "claude-*" → anthropic, "gemini-*" → gemini
 *   7. Default (codex)
 */

import type { UpstreamAdapter } from "./upstream-adapter.js";
import type { ApiKeyPool, ApiKeyEntry } from "../auth/api-key-pool.js";
import type { ApiKeyProvider } from "../auth/api-key-catalog.js";
import { getModelAliases, getModelInfo, stripKnownModelSuffixes } from "../models/model-store.js";

/** Factory that creates an UpstreamAdapter for a given ApiKeyEntry. */
export type AdapterFactory = (entry: ApiKeyEntry) => UpstreamAdapter;

export type UpstreamRouteMatch =
  | { kind: "api-key"; adapter: UpstreamAdapter; entry: ApiKeyEntry; entries?: ApiKeyEntry[]; resolvedModel?: string }
  | { kind: "adapter"; adapter: UpstreamAdapter; resolvedModel?: string }
  | { kind: "codex"; adapter?: UpstreamAdapter; resolvedModel?: string }
  | { kind: "not-found" };

export interface DirectUpstreamCandidate {
  adapter: UpstreamAdapter;
  entry?: ApiKeyEntry;
  matchedModel?: string;
  resolvedModel?: string;
}

export class UpstreamRouter {
  private apiKeyPool: ApiKeyPool | null = null;
  private adapterFactory: AdapterFactory | null = null;
  /** Cache: apiKeyEntry.id → adapter instance. Invalidated when key changes. */
  private dynamicAdapters = new Map<string, { apiKey: string; adapter: UpstreamAdapter }>();

  private splitExplicitProvider(model: string): { tag: string; bareModel: string } | null {
    const colonIdx = model.indexOf(":");
    if (colonIdx <= 0) return null;
    const tag = model.slice(0, colonIdx);
    if (!this.adapters.has(tag)) return null;
    return { tag, bareModel: model.slice(colonIdx + 1) };
  }

  private resolvePoolModelCandidates(model: string): string[] {
    const explicitProvider = this.splitExplicitProvider(model);
    return explicitProvider ? [model, explicitProvider.bareModel] : [model];
  }

  private getEntryResolvedModel(entry: ApiKeyEntry): string {
    return entry.model?.trim() || entry.models[0]?.trim() || "";
  }

  private sortEntries(entries: ApiKeyEntry[]): ApiKeyEntry[] {
    return [...entries].sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      const aLast = a.lastUsedAt ?? "";
      const bLast = b.lastUsedAt ?? "";
      if (aLast !== bLast) return aLast.localeCompare(bLast);
      return a.addedAt.localeCompare(b.addedAt);
    });
  }

  private getFallbackProviders(model: string): ApiKeyProvider[] {
    const explicitProvider = this.splitExplicitProvider(model);
    if (explicitProvider?.tag === "openai") return ["openai", "openrouter", "custom"];
    if (explicitProvider?.tag === "anthropic") return ["anthropic"];
    if (explicitProvider?.tag === "gemini") return ["gemini"];
    if (/^claude/i.test(model)) return ["anthropic"];
    if (/^gemini/i.test(model)) return ["gemini"];
    if (this.isKnownCodexModel(model)) return ["openai", "openrouter", "custom"];
    return [];
  }

  private resolveExactApiKeyCandidates(model: string): DirectUpstreamCandidate[] {
    if (!this.apiKeyPool || !this.adapterFactory) return [];

    for (const candidateModel of this.resolvePoolModelCandidates(model)) {
      const entries = this.apiKeyPool.getByModel(candidateModel);
      if (entries.length > 0) {
        return entries.map((entry) => ({
          entry,
          adapter: this.getOrCreateDynamicAdapter(entry),
          matchedModel: model,
          resolvedModel: candidateModel,
        }));
      }
    }
    return [];
  }

  private resolveFallbackApiKeyCandidates(model: string): DirectUpstreamCandidate[] {
    if (!this.apiKeyPool || !this.adapterFactory) return [];
    const fallbackProviders = new Set(this.getFallbackProviders(model));
    if (fallbackProviders.size === 0) return [];

    const fallbackEntries = this.sortEntries(
      this.apiKeyPool.getAll().filter((entry) =>
        entry.status === "active" &&
        fallbackProviders.has(entry.provider) &&
        this.getEntryResolvedModel(entry).length > 0,
      ),
    );

    return fallbackEntries.map((entry) => ({
      entry,
      adapter: this.getOrCreateDynamicAdapter(entry),
      matchedModel: model,
      resolvedModel: this.getEntryResolvedModel(entry),
    }));
  }

  constructor(
    private readonly adapters: Map<string, UpstreamAdapter>,
    private readonly modelRouting: Record<string, string>,
    private readonly defaultTag: string,
  ) {}

  /** Attach the runtime API key pool for dynamic model resolution. */
  setApiKeyPool(pool: ApiKeyPool, factory: AdapterFactory): void {
    this.apiKeyPool = pool;
    this.adapterFactory = factory;
  }

  resolveMatch(model: string): UpstreamRouteMatch {
    return this.resolveMatchInternal(model.trim(), new Set<string>());
  }

  private resolveMatchInternal(model: string, seenAliases: Set<string>): UpstreamRouteMatch {
    const explicitProvider = this.splitExplicitProvider(model);

    const apiKeyCandidates = this.resolveExactApiKeyCandidates(model);
    if (apiKeyCandidates.length > 0) {
      const [firstCandidate, ...restCandidates] = apiKeyCandidates;
      const entry = firstCandidate.entry!;
      this.apiKeyPool?.markUsed(entry.id);
      return {
        kind: "api-key",
        adapter: firstCandidate.adapter,
        entry,
        entries: [entry, ...restCandidates.map((candidate) => candidate.entry!).filter(Boolean)],
        resolvedModel: firstCandidate.resolvedModel,
      };
    }

    if (explicitProvider) {
      const adapter = this.adapters.get(explicitProvider.tag);
      if (adapter) return { kind: "adapter", adapter };
    }

    const aliases = getModelAliases();
    const aliasTarget = aliases[model]?.trim();
    if (aliasTarget) {
      if (seenAliases.has(model) || seenAliases.has(aliasTarget)) {
        return { kind: "not-found" };
      }
      seenAliases.add(model);
      const match = this.resolveMatchInternal(aliasTarget, seenAliases);
      return withResolvedModel(match, match.kind === "not-found" ? aliasTarget : match.resolvedModel ?? aliasTarget);
    }

    const suffixBase = stripKnownModelSuffixes(model).modelName;
    const suffixAliasTarget = suffixBase !== model ? aliases[suffixBase]?.trim() : undefined;
    if (suffixAliasTarget) {
      if (seenAliases.has(suffixBase) || seenAliases.has(suffixAliasTarget)) {
        return { kind: "not-found" };
      }
      seenAliases.add(suffixBase);
      const match = this.resolveMatchInternal(suffixAliasTarget, seenAliases);
      if (match.kind === "codex") {
        return withResolvedModel(match, match.resolvedModel ?? suffixAliasTarget);
      }
    }

    const routedTag = this.modelRouting[model];
    if (routedTag) {
      const adapter = this.adapters.get(routedTag);
      if (adapter) return { kind: routedTag === this.defaultTag ? "codex" : "adapter", adapter };
    }

    if (this.isKnownCodexModel(model)) {
      return { kind: "codex" };
    }

    if (/^claude/i.test(model) && this.adapters.has("anthropic")) {
      return { kind: "adapter", adapter: this.adapters.get("anthropic")! };
    }
    if (/^gemini/i.test(model) && this.adapters.has("gemini")) {
      return { kind: "adapter", adapter: this.adapters.get("gemini")! };
    }

    return { kind: "not-found" };
  }

  resolve(model: string): UpstreamAdapter {
    const match = this.resolveMatch(model);
    if (match.kind === "not-found" || !match.adapter) {
      throw new Error(`No upstream adapter available for model \"${model}\"`);
    }
    return match.adapter;
  }

  isCodexModel(model: string): boolean {
    return this.resolveMatch(model).kind === "codex";
  }

  hasApiKeyModel(model: string): boolean {
    return this.resolveMatch(model).kind === "api-key";
  }

  resolveDirectCandidates(model: string): DirectUpstreamCandidate[] {
    const apiKeyCandidates = this.resolveExactApiKeyCandidates(model);
    const fallbackCandidates = this.resolveFallbackApiKeyCandidates(model);
    if (apiKeyCandidates.length > 0 || fallbackCandidates.length > 0) {
      const seen = new Set<string>();
      const out: DirectUpstreamCandidate[] = [];
      for (const candidate of [...apiKeyCandidates, ...fallbackCandidates]) {
        const key = candidate.entry
          ? `${candidate.entry.id}:${candidate.resolvedModel ?? ""}`
          : `${candidate.adapter.tag}:${candidate.resolvedModel ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(candidate);
      }
      return out;
    }

    const match = this.resolveMatch(model);
    if (match.kind === "adapter") {
      return [{ adapter: match.adapter, resolvedModel: match.resolvedModel ?? model }];
    }
    return [];
  }

  private isKnownCodexModel(model: string): boolean {
    const aliases = getModelAliases();
    const trimmed = model.trim();
    if (aliases[trimmed]) return true;
    if (getModelInfo(trimmed)) return true;

    const stripped = stripKnownModelSuffixes(trimmed);
    if (stripped.modelName !== trimmed && getModelInfo(stripped.modelName)) return true;

    if (/^(gpt|o\d|codex)/i.test(trimmed)) return true;

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx > 0 && !this.adapters.has(trimmed.slice(0, colonIdx))) {
      return getModelInfo(trimmed) !== undefined;
    }

    return false;
  }

  private getOrCreateDynamicAdapter(entry: ApiKeyEntry): UpstreamAdapter {
    const cached = this.dynamicAdapters.get(entry.id);
    if (cached && cached.apiKey === entry.apiKey) return cached.adapter;
    const adapter = this.adapterFactory!(entry);
    this.dynamicAdapters.set(entry.id, { apiKey: entry.apiKey, adapter });
    return adapter;
  }
}
function withResolvedModel(match: UpstreamRouteMatch, resolvedModel: string): UpstreamRouteMatch {
  if (match.kind === "not-found") return match;
  if (match.resolvedModel) return match;
  return { ...match, resolvedModel };
}
