/**
 * Model routes — pure route handlers reading from model-store singleton.
 */

import { Hono } from "hono";
import type { OpenAIModel, OpenAIModelList } from "../types/openai.js";
import {
  getModelCatalog,
  getModelAliases,
  getModelInfo,
  getModelStoreDebug,
  type CodexModelInfo,
} from "../models/model-store.js";
import { triggerImmediateRefresh } from "../models/model-fetcher.js";
import { getConfig } from "../config.js";
import type { ApiKeyPool } from "../auth/api-key-pool.js";

// --- Routes ---

/** Stable timestamp used for all model `created` fields (2023-11-14T22:13:20Z). */
const MODEL_CREATED_TIMESTAMP = 1700000000;

function toOpenAIModel(info: CodexModelInfo): OpenAIModel {
  return {
    id: info.id,
    object: "model",
    created: MODEL_CREATED_TIMESTAMP,
    owned_by: "openai",
  };
}

function toRuntimeOpenAIModel(id: string): OpenAIModel {
  return {
    id,
    object: "model",
    created: MODEL_CREATED_TIMESTAMP,
    owned_by: "openai",
  };
}

function buildApiRootResponse() {
  return {
    object: "service",
    service: "codex-proxy",
    basePath: "/v1",
    endpoints: [
      "/v1/models",
      "/v1/chat/completions",
      "/v1/messages",
      "/v1/responses",
    ],
  };
}

export function createModelRoutes(apiKeyPool?: ApiKeyPool): Hono {
  const app = new Hono();

  function buildModelListResponse(): OpenAIModelList {
    const catalog = getModelCatalog();
    const aliases = getModelAliases();
    const modelsById = new Map<string, OpenAIModel>();

    for (const model of catalog) {
      modelsById.set(model.id, toOpenAIModel(model));
    }
    for (const alias of Object.keys(aliases)) {
      modelsById.set(alias, toRuntimeOpenAIModel(alias));
    }
    for (const modelId of apiKeyPool?.getActiveModels() ?? []) {
      modelsById.set(modelId, toRuntimeOpenAIModel(modelId));
    }

    return { object: "list", data: [...modelsById.values()] };
  }

  app.get("/v1/models", (c) => {
    return c.json(buildModelListResponse());
  });

  // Compatibility response for clients that probe the API base path directly.
  app.get("/v1", (c) => {
    return c.json(buildApiRootResponse());
  });

  app.get("/v1/", (c) => {
    return c.json(buildApiRootResponse());
  });

  // Compatibility alias for clients that incorrectly call the singular path.
  app.get("/v1/model", (c) => {
    return c.json(buildModelListResponse());
  });

  // Full catalog with reasoning efforts (for dashboard UI)
  // Must be before :modelId to avoid being matched as a model ID
  app.get("/v1/models/catalog", (c) => {
    // Default outputModalities to ["text"] for chat-family entries that don't
    // set it explicitly, matching the interface's documented default.
    return c.json(
      getModelCatalog().map((m) => ({
        ...m,
        outputModalities: m.outputModalities ?? ["text"],
      })),
    );
  });

  app.get("/v1/models/:modelId", (c) => {
    const modelId = c.req.param("modelId");
    const catalog = getModelCatalog();
    const aliases = getModelAliases();

    const info = catalog.find((m) => m.id === modelId);
    if (info) return c.json(toOpenAIModel(info));

    const resolved = aliases[modelId];
    if (resolved) {
      return c.json(toRuntimeOpenAIModel(modelId));
    }

    if (apiKeyPool?.hasActiveModel(modelId)) {
      return c.json(toRuntimeOpenAIModel(modelId));
    }

    c.status(404);
    return c.json({
      error: {
        message: `Model '${modelId}' not found`,
        type: "invalid_request_error",
        param: "model",
        code: "model_not_found",
      },
    });
  });

  // Extended endpoint: model details with reasoning efforts
  app.get("/v1/models/:modelId/info", (c) => {
    const modelId = c.req.param("modelId");
    const aliases = getModelAliases();
    const resolved = aliases[modelId] ?? modelId;
    const info = getModelInfo(resolved);
    if (!info) {
      c.status(404);
      return c.json({ error: `Model '${modelId}' not found` });
    }
    return c.json(info);
  });

  // Debug endpoint: model store internals
  app.get("/debug/models", (c) => {
    return c.json(getModelStoreDebug());
  });

  // Admin endpoint: trigger immediate model refresh
  app.post("/admin/refresh-models", (c) => {
    const config = getConfig();
    const configKey = config.server.proxy_api_key;
    if (configKey) {
      const authHeader = c.req.header("Authorization") ?? "";
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
      if (token !== configKey) {
        c.status(401);
        return c.json({ error: "Unauthorized" });
      }
    }
    triggerImmediateRefresh();
    return c.json({ ok: true, message: "Model refresh triggered" });
  });

  return app;
}
