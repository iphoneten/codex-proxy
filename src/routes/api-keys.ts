/**
 * API key management routes.
 * CRUD + import/export + catalog for third-party provider API keys.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { ApiKeyEntry, ApiKeyPool } from "../auth/api-key-pool.js";
import { PROVIDER_CATALOG, type UpstreamProtocol } from "../auth/api-key-catalog.js";

const VALID_PROVIDERS = ["anthropic", "openai", "gemini", "openrouter", "custom"] as const;
const VALID_PROTOCOLS = ["openai", "anthropic", "gemini"] as const;
const ModelsSchema = z.array(z.string().trim().min(1)).min(1).transform((models) => [...new Set(models)]);

const ApiKeyBindingSchema = z.object({
  provider: z.enum(VALID_PROVIDERS),
  protocol: z.enum(VALID_PROTOCOLS).optional(),
  models: ModelsSchema,
  modelMap: z.record(z.string().trim().min(1), z.string().trim().min(1)).optional(),
  apiKey: z.string().min(1),
  baseUrl: z.string().url().optional(),
  label: z.string().max(64).nullable().optional(),
  priority: z.number().int().optional(),
  maxRetries: z.number().int().min(0).max(10).optional(),
}).refine(
  (d) => d.provider !== "custom" || Boolean(d.baseUrl),
  { message: "baseUrl is required for custom providers" },
);

const FetchCustomModelsSchema = z.object({
  provider: z.literal("custom"),
  protocol: z.enum(VALID_PROTOCOLS).optional(),
  apiKey: z.string().trim().min(1),
  baseUrl: z.string().trim().url(),
});

const BulkImportSchema = z.object({
  keys: z.array(ApiKeyBindingSchema).min(1),
});

type ApiKeyBindingInput = z.infer<typeof ApiKeyBindingSchema>;

function isProtocolCompatible(
  provider: ApiKeyBindingInput["provider"],
  protocol: UpstreamProtocol | undefined,
): boolean {
  if (provider === "custom") return true;
  if (!protocol) return true;
  if (provider === "openrouter" && protocol === "openai") return true;
  return provider === protocol;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function normalizeFetchedModels(payload: unknown): Array<{ id: string; displayName: string }> {
  if (!payload || typeof payload !== "object" || !("data" in payload) || !Array.isArray(payload.data)) {
    return [];
  }

  const models: Array<{ id: string; displayName: string }> = [];
  for (const item of payload.data) {
    if (!item || typeof item !== "object") continue;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (!id) continue;
    const displayName = typeof item.name === "string" && item.name.trim()
      ? item.name.trim()
      : id;
    models.push({ id, displayName });
  }

  const deduped = new Map<string, { id: string; displayName: string }>();
  for (const model of models) deduped.set(model.id, model);
  return [...deduped.values()];
}

function addEntries(pool: ApiKeyPool, items: ApiKeyBindingInput[]): {
  added: number;
  failed: number;
  errors: string[];
  keys: ApiKeyEntry[];
} {
  const keys: ApiKeyEntry[] = [];
  const errors: string[] = [];

  for (const item of items) {
    try {
      keys.push(pool.add({
        provider: item.provider,
        protocol: item.protocol,
        models: item.models,
        modelMap: item.modelMap,
        apiKey: item.apiKey,
        baseUrl: item.baseUrl,
        label: item.label,
        priority: item.priority,
        maxRetries: item.maxRetries,
      }));
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  return { added: keys.length, failed: errors.length, errors, keys };
}

function toListEntry(entry: ApiKeyEntry) {
  return {
    ...entry,
    apiKey: "",
    apiKeyMasked: maskKey(entry.apiKey),
  };
}

function toImportableEntries<T extends { models?: string[]; model?: string }>(items: T[]): Array<Omit<T, "model" | "models"> & { models: string[] }> {
  return items.map(({ model, models, ...rest }) => ({
    ...rest,
    models: Array.isArray(models) && models.length > 0 ? models : (model ? [model] : []),
  }));
}

const LabelSchema = z.object({ label: z.string().max(64).nullable() });
const BaseUrlSchema = z.object({ baseUrl: z.string().trim().min(1) });
const ApiKeySchema = z.object({ apiKey: z.string().trim().min(1) });
const StatusSchema = z.object({ status: z.enum(["active", "disabled"]) });
const BatchDeleteSchema = z.object({ ids: z.array(z.string()).min(1) });
const ReorderSchema = z.object({ ids: z.array(z.string()).min(1) });
const AddModelsSchema = z.object({ models: ModelsSchema });
const RemoveModelsSchema = z.object({ models: ModelsSchema });
const ModelMapSchema = z.object({
  modelMap: z.record(z.string().trim().min(1), z.string().trim().min(1)),
});
const ProtocolSchema = z.object({
  protocol: z.enum(VALID_PROTOCOLS),
});

async function parseJsonRequest<T>(c: Context, schema: z.ZodSchema<T>): Promise<
  { ok: true; data: T } | { ok: false; response: Response }
> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    c.status(400);
    return { ok: false, response: c.json({ error: "Malformed JSON request body" }) };
  }

  const result = schema.safeParse(body);
  if (!result.success) {
    c.status(400);
    return { ok: false, response: c.json({ error: "Invalid request", details: result.error.issues }) };
  }

  return { ok: true, data: result.data };
}

function rejectProtocolMismatch(
  c: Context,
  body: { provider: ApiKeyBindingInput["provider"]; protocol?: UpstreamProtocol },
): Response | null {
  if (isProtocolCompatible(body.provider, body.protocol)) return null;
  c.status(400);
  return c.json({ error: "Built-in providers must use their matching protocol (openrouter uses openai)." });
}

export function createApiKeyRoutes(pool: ApiKeyPool): Hono {
  const app = new Hono();

  // ── Catalog (predefined models) ──────────────────────────────

  app.get("/auth/api-keys/catalog", (c) => {
    return c.json({ catalog: PROVIDER_CATALOG });
  });

  // ── List ──────────────────────────────────────────────────────

  app.get("/auth/api-keys", (c) => {
    return c.json({
      keys: pool.getAll().map(toListEntry),
    });
  });

  // ── Fetch custom provider models ───────────────────────────────

  app.post("/auth/api-keys/models", async (c) => {
    const parsed = await parseJsonRequest(c, FetchCustomModelsSchema);
    if (!parsed.ok) return parsed.response;

    const baseUrl = normalizeBaseUrl(parsed.data.baseUrl);
    const protocol = parsed.data.protocol ?? "openai";

    try {
      const upstream = await fetch(
        protocol === "gemini"
          ? `${baseUrl}/models?key=${encodeURIComponent(parsed.data.apiKey)}`
          : `${baseUrl}/models`,
        {
          headers: protocol === "anthropic"
            ? {
                "x-api-key": parsed.data.apiKey,
                "anthropic-version": "2023-06-01",
                "Accept": "application/json",
              }
            : protocol === "gemini"
              ? { "Accept": "application/json" }
              : {
                  "Authorization": `Bearer ${parsed.data.apiKey}`,
                  "Accept": "application/json",
                },
        },
      );

      if (!upstream.ok) {
        if (upstream.status === 401 || upstream.status === 403) {
          c.status(upstream.status);
          return c.json({ error: "Failed to fetch models: unauthorized" });
        }
        c.status(502);
        return c.json({ error: "Failed to fetch models from provider" });
      }

      const payload = await upstream.json().catch(() => null);
      const models = normalizeFetchedModels(payload);
      if (models.length === 0) {
        c.status(502);
        return c.json({ error: "Provider returned no models" });
      }

      return c.json({ models });
    } catch {
      c.status(502);
      return c.json({ error: "Failed to reach provider" });
    }
  });

  // ── Export (full keys for re-import) ──────────────────────────

  app.get("/auth/api-keys/export", (c) => {
    return c.json({ keys: toImportableEntries(pool.exportForReimport()) });
  });

  // ── Import (bulk) ─────────────────────────────────────────────

  app.post("/auth/api-keys/import", async (c) => {
    const parsed = await parseJsonRequest(c, BulkImportSchema);
    if (!parsed.ok) return parsed.response;
    for (const item of parsed.data.keys) {
      const protocolError = rejectProtocolMismatch(c, item);
      if (protocolError) return protocolError;
    }
    const result = addEntries(pool, parsed.data.keys);
    return c.json({ success: true, added: result.added, failed: result.failed, errors: result.errors });
  });

  // ── Add single ────────────────────────────────────────────────

  app.post("/auth/api-keys", async (c) => {
    const parsed = await parseJsonRequest(c, ApiKeyBindingSchema);
    if (!parsed.ok) return parsed.response;
    const protocolError = rejectProtocolMismatch(c, parsed.data);
    if (protocolError) return protocolError;
    const result = addEntries(pool, [parsed.data]);
    return c.json({
      success: true,
      added: result.added,
      failed: result.failed,
      keys: result.keys.map(toListEntry),
    });
  });

  // ── Batch delete ──────────────────────────────────────────────

  app.post("/auth/api-keys/batch-delete", async (c) => {
    const parsed = await parseJsonRequest(c, BatchDeleteSchema);
    if (!parsed.ok) return parsed.response;
    let deleted = 0;
    for (const id of parsed.data.ids) {
      if (pool.remove(id)) deleted++;
    }
    return c.json({ success: true, deleted });
  });

  app.post("/auth/api-keys/reorder", async (c) => {
    const parsed = await parseJsonRequest(c, ReorderSchema);
    if (!parsed.ok) return parsed.response;
    if (!pool.reorder(parsed.data.ids)) {
      c.status(400);
      return c.json({ error: "Invalid API key order" });
    }
    return c.json({ success: true });
  });

  // ── Per-key routes ────────────────────────────────────────────

  app.delete("/auth/api-keys/:id", (c) => {
    if (!pool.remove(c.req.param("id"))) { c.status(404); return c.json({ error: "API key not found" }); }
    return c.json({ success: true });
  });

  app.patch("/auth/api-keys/:id/label", async (c) => {
    const parsed = await parseJsonRequest(c, LabelSchema);
    if (!parsed.ok) return parsed.response;
    if (!pool.setLabel(c.req.param("id"), parsed.data.label)) { c.status(404); return c.json({ error: "API key not found" }); }
    return c.json({ success: true });
  });

  app.patch("/auth/api-keys/:id/base-url", async (c) => {
    const parsed = await parseJsonRequest(c, BaseUrlSchema);
    if (!parsed.ok) return parsed.response;
    if (!pool.setBaseUrl(c.req.param("id"), parsed.data.baseUrl)) {
      c.status(404);
      return c.json({ error: "API key not found" });
    }
    return c.json({ success: true });
  });

  app.patch("/auth/api-keys/:id/protocol", async (c) => {
    const parsed = await parseJsonRequest(c, ProtocolSchema);
    if (!parsed.ok) return parsed.response;
    const entry = pool.getEntry(c.req.param("id"));
    if (!entry) {
      c.status(404);
      return c.json({ error: "API key not found" });
    }
    const protocolError = rejectProtocolMismatch(c, {
      provider: entry.provider,
      protocol: parsed.data.protocol,
    });
    if (protocolError) return protocolError;
    if (!pool.setProtocol(c.req.param("id"), parsed.data.protocol)) {
      c.status(404);
      return c.json({ error: "API key not found" });
    }
    return c.json({ success: true });
  });

  app.patch("/auth/api-keys/:id/api-key", async (c) => {
    const parsed = await parseJsonRequest(c, ApiKeySchema);
    if (!parsed.ok) return parsed.response;
    if (!pool.setApiKey(c.req.param("id"), parsed.data.apiKey)) {
      c.status(404);
      return c.json({ error: "API key not found" });
    }
    return c.json({ success: true });
  });

  app.get("/auth/api-keys/:id/api-key", (c) => {
    const entry = pool.getEntry(c.req.param("id"));
    if (!entry) {
      c.status(404);
      return c.json({ error: "API key not found" });
    }
    return c.json({ apiKey: entry.apiKey });
  });

  app.get("/auth/api-keys/:id/models", (c) => {
    const entry = pool.getEntry(c.req.param("id"));
    if (!entry) {
      c.status(404);
      return c.json({ error: "API key not found" });
    }
    return c.json({ models: entry.models });
  });

  app.get("/auth/api-keys/:id/model-map", (c) => {
    const entry = pool.getEntry(c.req.param("id"));
    if (!entry) {
      c.status(404);
      return c.json({ error: "API key not found" });
    }
    return c.json({ modelMap: entry.modelMap ?? {} });
  });

  app.post("/auth/api-keys/:id/models", async (c) => {
    const parsed = await parseJsonRequest(c, AddModelsSchema);
    if (!parsed.ok) return parsed.response;
    if (!pool.addModels(c.req.param("id"), parsed.data.models)) {
      c.status(404);
      return c.json({ error: "API key not found" });
    }
    return c.json({ success: true });
  });

  app.delete("/auth/api-keys/:id/models", async (c) => {
    const parsed = await parseJsonRequest(c, RemoveModelsSchema);
    if (!parsed.ok) return parsed.response;
    if (!pool.removeModels(c.req.param("id"), parsed.data.models)) {
      c.status(404);
      return c.json({ error: "API key not found or no models left" });
    }
    return c.json({ success: true });
  });

  app.patch("/auth/api-keys/:id/model-map", async (c) => {
    const parsed = await parseJsonRequest(c, ModelMapSchema);
    if (!parsed.ok) return parsed.response;
    if (!pool.setModelMap(c.req.param("id"), parsed.data.modelMap)) {
      c.status(404);
      return c.json({ error: "API key not found" });
    }
    return c.json({ success: true });
  });

  app.post("/auth/api-keys/:id/models/load", async (c) => {
    const entry = pool.getEntry(c.req.param("id"));
    if (!entry) {
      c.status(404);
      return c.json({ error: "API key not found" });
    }

    try {
      const upstream = await fetch(`${normalizeBaseUrl(entry.baseUrl)}/models`, {
        headers: {
          "Authorization": `Bearer ${entry.apiKey}`,
          "Accept": "application/json",
        },
      });

      if (!upstream.ok) {
        c.status(upstream.status === 401 || upstream.status === 403 ? upstream.status : 502);
        return c.json({
          error: upstream.status === 401 || upstream.status === 403
            ? "Failed to fetch models: unauthorized"
            : "Failed to fetch models from provider",
        });
      }

      const payload = await upstream.json().catch(() => null);
      const models = normalizeFetchedModels(payload).map((model) => model.id);
      if (models.length === 0) {
        c.status(502);
        return c.json({ error: "Provider returned no models" });
      }

      return c.json({ success: true, models });
    } catch {
      c.status(502);
      return c.json({ error: "Failed to reach provider" });
    }
  });

  app.patch("/auth/api-keys/:id/status", async (c) => {
    const parsed = await parseJsonRequest(c, StatusSchema);
    if (!parsed.ok) return parsed.response;
    if (!pool.setStatus(c.req.param("id"), parsed.data.status)) { c.status(404); return c.json({ error: "API key not found" }); }
    return c.json({ success: true });
  });

  app.patch("/auth/api-keys/:id/routing", async (c) => {
    const parsed = await parseJsonRequest(c, z.object({
      priority: z.number().int().optional(),
      maxRetries: z.number().int().min(0).max(10).optional(),
    }));
    if (!parsed.ok) return parsed.response;
    if (!pool.setRouting(c.req.param("id"), parsed.data)) {
      c.status(404);
      return c.json({ error: "API key not found" });
    }
    return c.json({ success: true });
  });

  return app;
}

function maskKey(key: string): string {
  if (key.length <= 8) return "****";
  return key.slice(0, 4) + "****" + key.slice(-4);
}
