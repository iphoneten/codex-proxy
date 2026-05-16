import { useState, useEffect, useCallback, useRef } from "preact/hooks";

export type ApiKeyProvider = "anthropic" | "openai" | "gemini" | "openrouter" | "custom";

export interface ApiKeyEntry {
  id: string;
  provider: ApiKeyProvider;
  model?: string;
  models: string[];
  apiKey: string;
  apiKeyMasked?: string;
  baseUrl: string;
  label: string | null;
  priority: number;
  maxRetries: number;
  status: "active" | "disabled" | "error";
  addedAt: string;
  lastUsedAt: string | null;
}

export interface CatalogModel {
  id: string;
  displayName: string;
}

export interface ProviderMeta {
  displayName: string;
  defaultBaseUrl: string;
  models: CatalogModel[];
}

export interface FetchCustomModelsInput {
  provider: "custom";
  apiKey: string;
  baseUrl: string;
}

export type Catalog = Record<string, ProviderMeta>;

export function useApiKeys() {
  const [keys, setKeys] = useState<ApiKeyEntry[]>([]);
  const [catalog, setCatalog] = useState<Catalog>({});
  const [loading, setLoading] = useState(true);
  const customModelCacheRef = useRef(new Map<string, CatalogModel[]>());

  const loadKeys = useCallback(async () => {
    try {
      const resp = await fetch("/auth/api-keys");
      const data = await resp.json();
      setKeys((data.keys || []).map((entry: ApiKeyEntry) => ({
        ...entry,
        apiKey: "",
        apiKeyMasked: entry.apiKeyMasked ?? "",
      })));
    } catch {
      setKeys([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadCatalog = useCallback(async () => {
    try {
      const resp = await fetch("/auth/api-keys/catalog");
      const data = await resp.json();
      setCatalog(data.catalog || {});
    } catch {
      setCatalog({});
    }
  }, []);

  useEffect(() => {
    loadKeys();
    loadCatalog();
  }, [loadKeys, loadCatalog]);

  const addKey = useCallback(async (input: {
    provider: ApiKeyProvider;
    models: string[];
    apiKey: string;
    baseUrl?: string;
    label?: string | null;
    priority?: number;
    maxRetries?: number;
  }): Promise<{ ok: boolean; error?: string }> => {
    try {
      const resp = await fetch("/auth/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const data = await resp.json();
      if (!resp.ok) return { ok: false, error: data.error || "Failed" };
      await loadKeys();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Network error" };
    }
  }, [loadKeys]);

  const deleteKey = useCallback(async (id: string) => {
    try {
      await fetch(`/auth/api-keys/${id}`, { method: "DELETE" });
      await loadKeys();
    } catch { /* ignore */ }
  }, [loadKeys]);

  const toggleStatus = useCallback(async (id: string, status: "active" | "disabled") => {
    try {
      await fetch(`/auth/api-keys/${id}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      await loadKeys();
    } catch { /* ignore */ }
  }, [loadKeys]);

  const updateLabel = useCallback(async (id: string, label: string | null) => {
    try {
      await fetch(`/auth/api-keys/${id}/label`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label }),
      });
      await loadKeys();
    } catch { /* ignore */ }
  }, [loadKeys]);

  const updateRouting = useCallback(async (id: string, routing: { priority?: number; maxRetries?: number }) => {
    try {
      await fetch(`/auth/api-keys/${id}/routing`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(routing),
      });
      await loadKeys();
    } catch { /* ignore */ }
  }, [loadKeys]);

  const updateBaseUrl = useCallback(async (id: string, baseUrl: string) => {
    try {
      await fetch(`/auth/api-keys/${id}/base-url`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseUrl }),
      });
      await loadKeys();
    } catch { /* ignore */ }
  }, [loadKeys]);

  const updateApiKey = useCallback(async (id: string, apiKey: string) => {
    try {
      await fetch(`/auth/api-keys/${id}/api-key`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey }),
      });
      await loadKeys();
    } catch { /* ignore */ }
  }, [loadKeys]);

  const revealApiKey = useCallback(async (id: string): Promise<{ ok: true; apiKey: string } | { ok: false; error: string }> => {
    try {
      const resp = await fetch(`/auth/api-keys/${id}/api-key`);
      const data = await resp.json();
      if (!resp.ok) return { ok: false, error: data.error || "Failed to load API key" };
      return { ok: true, apiKey: typeof data.apiKey === "string" ? data.apiKey : "" };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Network error" };
    }
  }, []);

  const loadEntryModels = useCallback(async (id: string): Promise<{ ok: true; models: string[] } | { ok: false; error: string }> => {
    try {
      const resp = await fetch(`/auth/api-keys/${id}/models`);
      const data = await resp.json();
      if (!resp.ok) return { ok: false, error: data.error || "Failed to load models" };
      return { ok: true, models: Array.isArray(data.models) ? data.models : [] };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Network error" };
    }
  }, []);

  const refreshEntryModels = useCallback(async (id: string): Promise<{ ok: true; models: string[] } | { ok: false; error: string }> => {
    try {
      const resp = await fetch(`/auth/api-keys/${id}/models/load`, { method: "POST" });
      const data = await resp.json();
      if (!resp.ok) return { ok: false, error: data.error || "Failed to fetch models" };
      return { ok: true, models: Array.isArray(data.models) ? data.models : [] };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Network error" };
    }
  }, []);

  const addEntryModels = useCallback(async (id: string, models: string[]): Promise<{ ok: boolean; error?: string }> => {
    try {
      const resp = await fetch(`/auth/api-keys/${id}/models`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ models }),
      });
      const data = await resp.json();
      if (!resp.ok) return { ok: false, error: data.error || "Failed to add models" };
      await loadKeys();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Network error" };
    }
  }, [loadKeys]);

  const removeEntryModels = useCallback(async (id: string, models: string[]): Promise<{ ok: boolean; error?: string }> => {
    try {
      const resp = await fetch(`/auth/api-keys/${id}/models`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ models }),
      });
      const data = await resp.json();
      if (!resp.ok) return { ok: false, error: data.error || "Failed to remove models" };
      await loadKeys();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Network error" };
    }
  }, [loadKeys]);

  const importKeys = useCallback(async (file: File): Promise<{ added: number; failed: number; errors: string[] }> => {
    const text = await file.text();
    const body = JSON.parse(text);
    const resp = await fetch("/auth/api-keys/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    await loadKeys();
    return { added: data.added || 0, failed: data.failed || 0, errors: data.errors || [] };
  }, [loadKeys]);

  const fetchCustomModels = useCallback(async (input: FetchCustomModelsInput): Promise<{ ok: true; models: CatalogModel[] } | { ok: false; error: string }> => {
    const cacheKey = `${input.baseUrl.trim()}::${input.apiKey.trim()}`;
    const cached = customModelCacheRef.current.get(cacheKey);
    if (cached) return { ok: true, models: cached };

    try {
      const resp = await fetch("/auth/api-keys/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: input.provider,
          apiKey: input.apiKey.trim(),
          baseUrl: input.baseUrl.trim(),
        }),
      });
      const data = await resp.json();
      if (!resp.ok) return { ok: false, error: data.error || "Failed to fetch models" };
      const models = Array.isArray(data.models) ? data.models : [];
      customModelCacheRef.current.set(cacheKey, models);
      return { ok: true, models };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Network error" };
    }
  }, []);

  const exportKeys = useCallback(async () => {
    const resp = await fetch("/auth/api-keys/export");
    const data = await resp.json();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "api-keys-export.json";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, []);

  return {
    keys,
    catalog,
    loading,
    addKey,
    deleteKey,
    toggleStatus,
    updateLabel,
    updateBaseUrl,
    updateApiKey,
    revealApiKey,
    loadEntryModels,
    refreshEntryModels,
    addEntryModels,
    removeEntryModels,
    updateRouting,
    importKeys,
    exportKeys,
    fetchCustomModels,
    refresh: loadKeys,
  };
}
