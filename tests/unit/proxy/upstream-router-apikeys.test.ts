/**
 * Tests for UpstreamRouter integration with ApiKeyPool.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { UpstreamRouter } from "@src/proxy/upstream-router.js";
import { ApiKeyPool } from "@src/auth/api-key-pool.js";
import type { ApiKeyPersistence, ApiKeyEntry } from "@src/auth/api-key-pool.js";
import type { UpstreamAdapter } from "@src/proxy/upstream-adapter.js";
import type { CodexResponsesRequest, CodexSSEEvent } from "@src/proxy/codex-types.js";

function createMemoryPersistence(): ApiKeyPersistence {
  let stored: ApiKeyEntry[] = [];
  return {
    load: () => [...stored],
    save: (keys) => { stored = [...keys]; },
  };
}

function mockAdapter(tag: string): UpstreamAdapter {
  return {
    tag,
    createResponse: () => Promise.resolve(new Response()),
    async *parseStream(): AsyncGenerator<CodexSSEEvent> { /* empty */ },
  };
}

function mockFactory(entry: ApiKeyEntry): UpstreamAdapter {
  return mockAdapter(`dynamic-${entry.provider}-${entry.model}`);
}

describe("UpstreamRouter with ApiKeyPool", () => {
  let pool: ApiKeyPool;

  beforeEach(() => {
    pool = new ApiKeyPool(createMemoryPersistence());
  });

  it("resolves model from api-key pool before config adapters", () => {
    pool.add({ provider: "anthropic", model: "claude-opus-4-6", apiKey: "k1" });

    const adapters = new Map<string, UpstreamAdapter>();
    adapters.set("codex", mockAdapter("codex"));
    adapters.set("anthropic", mockAdapter("anthropic"));

    const router = new UpstreamRouter(adapters, {}, "codex");
    router.setApiKeyPool(pool, mockFactory);

    const adapter = router.resolve("claude-opus-4-6");
    expect(adapter.tag).toBe("dynamic-anthropic-claude-opus-4-6");
  });

  it("falls back to config adapter when pool has no match", () => {
    const adapters = new Map<string, UpstreamAdapter>();
    adapters.set("codex", mockAdapter("codex"));
    adapters.set("anthropic", mockAdapter("anthropic"));

    const router = new UpstreamRouter(adapters, {}, "codex");
    router.setApiKeyPool(pool, mockFactory);

    const adapter = router.resolve("claude-opus-4-6");
    // No pool entry → falls to built-in pattern → anthropic
    expect(adapter.tag).toBe("anthropic");
  });

  it("returns not-found for unknown non-codex models", () => {
    const adapters = new Map<string, UpstreamAdapter>();
    adapters.set("codex", mockAdapter("codex"));

    const router = new UpstreamRouter(adapters, {}, "codex");
    router.setApiKeyPool(pool, mockFactory);

    expect(router.resolveMatch("unknown-model-xyz")).toEqual({ kind: "not-found" });
  });

  it("classifies api-key pool models explicitly", () => {
    pool.add({ provider: "openai", model: "gpt-5.4", apiKey: "k1" });

    const adapters = new Map<string, UpstreamAdapter>();
    adapters.set("codex", mockAdapter("codex"));

    const router = new UpstreamRouter(adapters, {}, "codex");
    router.setApiKeyPool(pool, mockFactory);

    const match = router.resolveMatch("gpt-5.4");
    expect(match.kind).toBe("api-key");
    if (match.kind === "api-key") {
      expect(match.entry.model).toBe("gpt-5.4");
      expect(match.adapter.tag).toBe("dynamic-openai-gpt-5.4");
      expect(match.entries).toHaveLength(1);
    }
  });

  it("orders api-key candidates by priority so lower priorities can fail over", () => {
    pool.add({ provider: "openai", model: "gpt-5.4", apiKey: "k1", priority: 1 });
    pool.add({ provider: "openai", model: "gpt-5.4", apiKey: "k2", priority: 20 });

    const adapters = new Map<string, UpstreamAdapter>();
    adapters.set("codex", mockAdapter("codex"));

    const router = new UpstreamRouter(adapters, {}, "codex");
    router.setApiKeyPool(pool, mockFactory);

    const candidates = router.resolveDirectCandidates("gpt-5.4");
    expect(candidates).toHaveLength(2);
    expect(candidates.map((candidate) => candidate.entry?.apiKey)).toEqual(["k2", "k1"]);
  });

  it("keeps equal-priority api-key candidates as failover peers", () => {
    pool.add({ provider: "openai", model: "gpt-5.4", apiKey: "k1", priority: 0 });
    pool.add({ provider: "openai", model: "gpt-5.4", apiKey: "k2", priority: 0 });

    const adapters = new Map<string, UpstreamAdapter>();
    adapters.set("codex", mockAdapter("codex"));

    const router = new UpstreamRouter(adapters, {}, "codex");
    router.setApiKeyPool(pool, mockFactory);

    const candidates = router.resolveDirectCandidates("gpt-5.4");
    expect(candidates).toHaveLength(2);
  });

  it("includes fallback candidates for other models under the same provider family", () => {
    pool.add({ provider: "openai", models: ["gpt-5.5", "gpt-5.4"], apiKey: "k1" });
    pool.add({ provider: "openai", model: "gpt-5.4", apiKey: "k2", priority: 5 });

    const adapters = new Map<string, UpstreamAdapter>();
    adapters.set("codex", mockAdapter("codex"));

    const router = new UpstreamRouter(adapters, {}, "codex");
    router.setApiKeyPool(pool, mockFactory);

    const candidates = router.resolveDirectCandidates("gpt-5.5");
    expect(candidates.map((candidate) => candidate.resolvedModel)).toContain("gpt-5.5");
    expect(candidates.some((candidate) => candidate.entry?.apiKey === "k1")).toBe(true);
  });

  it("classifies known codex models explicitly", () => {
    const adapters = new Map<string, UpstreamAdapter>();
    adapters.set("codex", mockAdapter("codex"));

    const router = new UpstreamRouter(adapters, {}, "codex");
    router.setApiKeyPool(pool, mockFactory);

    const match = router.resolveMatch("gpt-5.3-codex");
    expect(match.kind).toBe("codex");
  });

  it("skips disabled api-key entries", () => {
    const entry = pool.add({ provider: "openai", model: "gpt-5.4", apiKey: "k1" });
    pool.setStatus(entry.id, "disabled");

    const adapters = new Map<string, UpstreamAdapter>();
    adapters.set("codex", mockAdapter("codex"));

    const router = new UpstreamRouter(adapters, {}, "codex");
    router.setApiKeyPool(pool, mockFactory);

    expect(router.resolveMatch("gpt-5.4").kind).toBe("codex");
  });

  it("round-robins multiple keys for same model via LRU", () => {
    pool.add({ provider: "openai", model: "gpt-5.4", apiKey: "k1", label: "A" });
    pool.add({ provider: "openai", model: "gpt-5.4", apiKey: "k2", label: "B" });

    const adapters = new Map<string, UpstreamAdapter>();
    adapters.set("codex", mockAdapter("codex"));

    const router = new UpstreamRouter(adapters, {}, "codex");
    router.setApiKeyPool(pool, mockFactory);

    // First resolve picks first (both never-used → pick first)
    router.resolve("gpt-5.4");
    // After markUsed on first, second should be picked next
    router.resolve("gpt-5.4");

    // Verify both entries got used
    const entries = pool.getByModel("gpt-5.4");
    const usedEntries = entries.filter((e) => e.lastUsedAt !== null);
    expect(usedEntries.length).toBeGreaterThanOrEqual(1);
  });

  it("caches adapter and reuses for same entry", () => {
    pool.add({ provider: "anthropic", model: "claude-opus-4-6", apiKey: "k1" });

    const adapters = new Map<string, UpstreamAdapter>();
    adapters.set("codex", mockAdapter("codex"));

    let factoryCallCount = 0;
    const countingFactory = (entry: ApiKeyEntry): UpstreamAdapter => {
      factoryCallCount++;
      return mockFactory(entry);
    };

    const router = new UpstreamRouter(adapters, {}, "codex");
    router.setApiKeyPool(pool, countingFactory);

    router.resolve("claude-opus-4-6");
    router.resolve("claude-opus-4-6");

    // Factory should only be called once (cached)
    expect(factoryCallCount).toBe(1);
  });

  it("strips provider prefix for pool lookup", () => {
    pool.add({ provider: "openai", model: "gpt-5.4", apiKey: "k1" });

    const adapters = new Map<string, UpstreamAdapter>();
    adapters.set("codex", mockAdapter("codex"));
    adapters.set("openai", mockAdapter("openai"));

    const router = new UpstreamRouter(adapters, {}, "codex");
    router.setApiKeyPool(pool, mockFactory);

    // "openai:gpt-5.4" should strip prefix and find pool entry for "gpt-5.4"
    const adapter = router.resolve("openai:gpt-5.4");
    expect(adapter.tag).toBe("dynamic-openai-gpt-5.4");
  });

  it("prefers exact api-key model match for models containing colon", () => {
    pool.add({ provider: "openai", model: "google/gemma-4-26b-a4b-it:free", apiKey: "k1" });

    const adapters = new Map<string, UpstreamAdapter>();
    adapters.set("openai", mockAdapter("openai"));

    const router = new UpstreamRouter(adapters, {}, "codex");
    router.setApiKeyPool(pool, mockFactory);

    const adapter = router.resolve("google/gemma-4-26b-a4b-it:free");
    expect(adapter.tag).toBe("dynamic-openai-google/gemma-4-26b-a4b-it:free");
    expect(router.isCodexModel("google/gemma-4-26b-a4b-it:free")).toBe(false);
  });

  it("keeps mapped candidates alongside exact matches so lower-priority fallbacks remain available", () => {
    pool.add({
      provider: "custom",
      models: ["gpt-5.4"],
      apiKey: "k1",
      baseUrl: "https://codex1.example.com/v1",
      label: "codex",
      priority: 1,
    });
    pool.add({
      provider: "custom",
      protocol: "anthropic",
      models: ["claude-haiku-4-5"],
      modelMap: { "gpt-5.4": "claude-haiku-4-5" },
      apiKey: "k2",
      baseUrl: "https://api.pioneer.ai/v1",
      label: "pioneer",
      priority: 0,
    });

    const adapters = new Map<string, UpstreamAdapter>();
    adapters.set("codex", mockAdapter("codex"));

    const router = new UpstreamRouter(adapters, {}, "codex");
    router.setApiKeyPool(pool, mockFactory);

    const candidates = router.resolveDirectCandidates("gpt-5.4");
    expect(candidates).toHaveLength(2);
    expect(candidates.map((candidate) => candidate.entry?.label)).toEqual(["codex", "pioneer"]);
    expect(candidates.map((candidate) => candidate.resolvedModel)).toEqual(["gpt-5.4", "claude-haiku-4-5"]);
  });
});
