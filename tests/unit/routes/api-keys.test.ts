/**
 * Tests for third-party API key management routes.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiKeyPool } from "@src/auth/api-key-pool.js";
import type { ApiKeyEntry, ApiKeyPersistence } from "@src/auth/api-key-pool.js";
import { createApiKeyRoutes } from "@src/routes/api-keys.js";

function createMemoryPersistence(): ApiKeyPersistence {
  let stored: ApiKeyEntry[] = [];
  return {
    load: () => [...stored],
    save: (keys) => {
      stored = [...keys];
    },
  };
}

describe("api key routes", () => {
  let pool: ApiKeyPool;
  let app: ReturnType<typeof createApiKeyRoutes>;

  beforeEach(() => {
    pool = new ApiKeyPool(createMemoryPersistence());
    app = createApiKeyRoutes(pool);
    vi.restoreAllMocks();
  });

  it("adds one stored entry per selected model and masks returned keys", async () => {
    const res = await app.request("/auth/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "openai",
        models: ["gpt-5.4", "gpt-5.4-mini", "gpt-5.4"],
        apiKey: "sk-1234567890abcdef",
        label: "Team",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ success: true, added: 1, failed: 0 });
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0].apiKeyMasked).toBe("sk-1****cdef");
    expect(body.keys[0].apiKey).toBe("");
    expect(pool.getAll().map((entry) => entry.models)).toEqual([["gpt-5.4", "gpt-5.4-mini"]]);
  });

  it("lists masked keys without exposing or overwriting the stored upstream secret", async () => {
    const added = pool.add({
      provider: "custom",
      models: ["gpt-5.4"],
      apiKey: "sk-1234567890abcdef",
      baseUrl: "https://example.com/v1",
      label: "relay-a",
    });

    const listRes = await app.request("/auth/api-keys");
    expect(listRes.status).toBe(200);

    const listBody = await listRes.json();
    expect(listBody.keys).toHaveLength(1);
    expect(listBody.keys[0].apiKey).toBe("");
    expect(listBody.keys[0].apiKeyMasked).toBe("sk-1****cdef");

    const labelRes = await app.request(`/auth/api-keys/${added.id}/label`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "relay-b" }),
    });
    expect(labelRes.status).toBe(200);
    expect(pool.getEntry(added.id)?.apiKey).toBe("sk-1234567890abcdef");
  });

  it("returns the full upstream secret only from the dedicated reveal endpoint", async () => {
    const added = pool.add({
      provider: "custom",
      models: ["gpt-5.4"],
      apiKey: "sk-1234567890abcdef",
      baseUrl: "https://example.com/v1",
    });

    const res = await app.request(`/auth/api-keys/${added.id}/api-key`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toEqual({ apiKey: "sk-1234567890abcdef" });
  });

  it("adds manual models to an existing upstream entry", async () => {
    const added = pool.add({
      provider: "custom",
      models: ["gpt-5.4"],
      apiKey: "sk-1234567890abcdef",
      baseUrl: "https://example.com/v1",
    });

    const res = await app.request(`/auth/api-keys/${added.id}/models`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ models: ["gpt-5.5", "gpt-5.3-codex"] }),
    });

    expect(res.status).toBe(200);
    expect(pool.getEntry(added.id)?.models).toEqual(["gpt-5.4", "gpt-5.5", "gpt-5.3-codex"]);
  });

  it("removes one model from an existing upstream entry", async () => {
    const added = pool.add({
      provider: "custom",
      models: ["gpt-5.4", "gpt-5.5", "gpt-5.3-codex"],
      apiKey: "sk-1234567890abcdef",
      baseUrl: "https://example.com/v1",
    });

    const res = await app.request(`/auth/api-keys/${added.id}/models`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ models: ["gpt-5.5"] }),
    });

    expect(res.status).toBe(200);
    expect(pool.getEntry(added.id)?.models).toEqual(["gpt-5.4", "gpt-5.3-codex"]);
  });

  it("rejects removing the last model from an upstream entry", async () => {
    const added = pool.add({
      provider: "custom",
      models: ["gpt-5.4"],
      apiKey: "sk-1234567890abcdef",
      baseUrl: "https://example.com/v1",
    });

    const res = await app.request(`/auth/api-keys/${added.id}/models`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ models: ["gpt-5.4"] }),
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "API key not found or no models left" });
    expect(pool.getEntry(added.id)?.models).toEqual(["gpt-5.4"]);
  });

  it("loads upstream models as candidates without mutating the existing entry", async () => {
    const added = pool.add({
      provider: "custom",
      models: ["gpt-5.4"],
      apiKey: "sk-1234567890abcdef",
      baseUrl: "https://example.com/v1",
    });

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      data: [
        { id: "gpt-5.5", name: "GPT-5.5" },
        { id: "gpt-5.3-codex" },
      ],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch);

    const res = await app.request(`/auth/api-keys/${added.id}/models/load`, { method: "POST" });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toMatchObject({
      success: true,
      models: ["gpt-5.5", "gpt-5.3-codex"],
    });
    expect(pool.getEntry(added.id)?.models).toEqual(["gpt-5.4"]);
  });

  it("requires baseUrl for custom provider keys", async () => {
    const res = await app.request("/auth/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "custom",
        models: ["custom-model"],
        apiKey: "secret",
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid request");
  });

  it("imports keys by expanding each entry's models", async () => {
    const res = await app.request("/auth/api-keys/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        keys: [
          {
            provider: "anthropic",
            models: ["claude-opus-4-6", "claude-sonnet-4-6"],
            apiKey: "sk-ant",
            label: null,
          },
          {
            provider: "custom",
            models: ["custom-a"],
            apiKey: "custom-key",
            baseUrl: "https://example.com/v1",
          },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ success: true, added: 2, failed: 0 });
    expect(pool.getAll().map((entry) => entry.models)).toEqual([
      ["claude-opus-4-6", "claude-sonnet-4-6"],
      ["custom-a"],
    ]);
  });

  it("exports stored single-model entries as importable multi-model entries", async () => {
    pool.add({ provider: "openai", model: "gpt-5.4", apiKey: "sk-openai", label: "A" });

    const res = await app.request("/auth/api-keys/export");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.keys).toEqual([
      {
        provider: "openai",
        models: ["gpt-5.4"],
        apiKey: "sk-openai",
        baseUrl: "https://api.openai.com/v1",
        label: "A",
        priority: 0,
        maxRetries: 2,
      },
    ]);
  });

  it("reorders upstream entries", async () => {
    const first = pool.add({ provider: "openai", model: "gpt-5.4", apiKey: "k1" });
    const second = pool.add({ provider: "openai", model: "gpt-5.4", apiKey: "k2" });
    const third = pool.add({ provider: "openai", model: "gpt-5.4", apiKey: "k3" });

    const res = await app.request("/auth/api-keys/reorder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [third.id, first.id, second.id] }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(pool.getByModel("gpt-5.4").map((entry) => entry.id)).toEqual([third.id, first.id, second.id]);
  });

  it("batch deletes existing ids and ignores missing ids", async () => {
    const first = pool.add({ provider: "openai", model: "gpt-5.4", apiKey: "k1" });
    const second = pool.add({ provider: "openai", model: "gpt-5.4-mini", apiKey: "k2" });

    const res = await app.request("/auth/api-keys/batch-delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [first.id, "missing", second.id] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: true, deleted: 2 });
    expect(pool.getAll()).toHaveLength(0);
  });
});
