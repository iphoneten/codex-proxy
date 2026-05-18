/**
 * Proxy Manager — Dashboard component for managing third-party upstream relays.
 * Supports add/delete/toggle/import/export with predefined model catalogs.
 */

import { useState, useCallback, useMemo, useRef, useEffect } from "preact/hooks";
import { useApiKeys } from "../../../shared/hooks/use-api-keys";
import type { ApiKeyProvider, ApiKeyEntry, CatalogModel } from "../../../shared/hooks/use-api-keys";
import { useUsageSummary, type UsageSummary } from "../../../shared/hooks/use-usage-stats";
import { formatNumber } from "./UsageChart";

const CUSTOM_MODELS_HINT = "请先输入上游密钥和地址，将会获取模型列表";
const CUSTOM_MODELS_FALLBACK_HINT = "模型列表获取失败，请手动输入模型名";

const PROVIDER_OPTIONS: Array<{ value: ApiKeyProvider; label: string }> = [
  { value: "anthropic", label: "Anthropic" },
  { value: "openai", label: "OpenAI" },
  { value: "gemini", label: "Google Gemini" },
  { value: "openrouter", label: "OpenRouter" },
  { value: "custom", label: "Custom" },
];

type CustomModelStatus = "idle" | "loading" | "loaded" | "fallback";

function normalizeCustomModelInput(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function renderModelChecklist(models: CatalogModel[], selectedModelSet: Set<string>, onToggle: (modelId: string) => void) {
  return (
    <div class="max-h-56 overflow-y-auto rounded-lg border border-gray-200 dark:border-border-dark bg-slate-50 dark:bg-bg-dark p-2 flex flex-col gap-1">
      {models.map((model) => (
        <label key={model.id} class="flex items-center gap-2 px-2 py-1 rounded hover:bg-white/70 dark:hover:bg-card-dark/70 text-sm text-slate-800 dark:text-text-main">
          <input
            type="checkbox"
            checked={selectedModelSet.has(model.id)}
            onChange={() => onToggle(model.id)}
          />
          <span>{model.displayName}</span>
          <span class="text-xs font-mono text-slate-400 dark:text-text-dim ml-auto">{model.id}</span>
        </label>
      ))}
    </div>
  );
}

interface GroupedApiKeyEntry extends ApiKeyEntry {
  sourceIds: string[];
}

function groupEntries(entries: ApiKeyEntry[]): GroupedApiKeyEntry[] {
  const grouped = new Map<string, GroupedApiKeyEntry>();
  for (const entry of entries) {
    const key = [
      entry.provider,
      entry.apiKeyMasked ?? entry.apiKey,
      entry.baseUrl,
      entry.label ?? "",
      entry.priority,
      entry.maxRetries,
      entry.status,
    ].join("::");
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, { ...entry, models: [...entry.models], sourceIds: [entry.id] });
      continue;
    }
    existing.models = [...new Set([...existing.models, ...entry.models])];
    if (!existing.model) existing.model = existing.models[0];
    existing.sourceIds.push(entry.id);
  }
  return [...grouped.values()];
}

interface UpstreamUsageEntry {
  key: string;
  provider: string;
  label: string;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  image_input_tokens: number;
  image_output_tokens: number;
  request_count: number;
  updated_at: string;
}

interface AggregatedUpstreamUsage {
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  image_input_tokens: number;
  image_output_tokens: number;
  request_count: number;
  updated_at: string | null;
}

function aggregateUsageForEntry(
  entry: GroupedApiKeyEntry,
  breakdown: UsageSummary["upstream_breakdown"] | undefined,
): AggregatedUpstreamUsage | null {
  if (!breakdown?.length) return null;
  const targetKeys = new Set(entry.sourceIds.map((id) => `api-key:${id}`));
  const matches = breakdown.filter((item) => targetKeys.has(item.key));
  if (matches.length === 0) return null;
  return matches.reduce<AggregatedUpstreamUsage>((acc, item) => ({
    input_tokens: acc.input_tokens + item.input_tokens,
    output_tokens: acc.output_tokens + item.output_tokens,
    cached_tokens: acc.cached_tokens + item.cached_tokens,
    image_input_tokens: acc.image_input_tokens + item.image_input_tokens,
    image_output_tokens: acc.image_output_tokens + item.image_output_tokens,
    request_count: acc.request_count + item.request_count,
    updated_at: acc.updated_at && acc.updated_at > item.updated_at ? acc.updated_at : item.updated_at,
  }), {
    input_tokens: 0,
    output_tokens: 0,
    cached_tokens: 0,
    image_input_tokens: 0,
    image_output_tokens: 0,
    request_count: 0,
    updated_at: null,
  });
}

function formatUsageUpdatedAt(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function AddKeyForm({ onAdd, catalog, fetchCustomModels }: {
  onAdd: (input: { provider: ApiKeyProvider; models: string[]; apiKey: string; baseUrl?: string; label?: string; priority?: number; maxRetries?: number }) => Promise<{ ok: boolean; error?: string }>;
  catalog: Record<string, { displayName: string; defaultBaseUrl: string; models: Array<{ id: string; displayName: string }> }>;
  fetchCustomModels: (input: { provider: "custom"; apiKey: string; baseUrl: string }) => Promise<{ ok: true; models: CatalogModel[] } | { ok: false; error: string }>;
}) {
  const [provider, setProvider] = useState<ApiKeyProvider>("custom");
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [label, setLabel] = useState("");
  const [priority, setPriority] = useState("0");
  const [maxRetries, setMaxRetries] = useState("2");
  const [manualModelsInput, setManualModelsInput] = useState("");
  const [customModels, setCustomModels] = useState<CatalogModel[]>([]);
  const [customModelStatus, setCustomModelStatus] = useState<CustomModelStatus>("idle");
  const [customModelMessage, setCustomModelMessage] = useState(CUSTOM_MODELS_HINT);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const latestCustomRequestRef = useRef(0);
  const latestResolvedSignatureRef = useRef("");

  const isCustom = provider === "custom";
  const providerCatalog = !isCustom ? catalog[provider]?.models ?? [] : [];
  const selectedModelSet = useMemo(() => new Set(selectedModels), [selectedModels]);

  const resetCustomModels = useCallback((status: CustomModelStatus = "idle", message = CUSTOM_MODELS_HINT) => {
    setCustomModels([]);
    setSelectedModels([]);
    setCustomModelStatus(status);
    setCustomModelMessage(message);
  }, []);

  const handleModelToggle = (modelId: string) => {
    setSelectedModels((prev) => prev.includes(modelId)
      ? prev.filter((id) => id !== modelId)
      : [...prev, modelId]);
  };

  const triggerCustomModelFetch = useCallback(async () => {
    if (!isCustom) return;

    const normalizedApiKey = apiKey.trim();
    const normalizedBaseUrl = baseUrl.trim();
    if (!normalizedApiKey || !normalizedBaseUrl) {
      resetCustomModels();
      return;
    }

    const signature = `${normalizedBaseUrl}::${normalizedApiKey}`;
    if (latestResolvedSignatureRef.current === signature && customModels.length > 0) return;

    const requestId = latestCustomRequestRef.current + 1;
    latestCustomRequestRef.current = requestId;
    setCustomModelStatus("loading");
    setCustomModelMessage("正在获取模型列表...");
    setError("");

    const result = await fetchCustomModels({
      provider: "custom",
      apiKey: normalizedApiKey,
      baseUrl: normalizedBaseUrl,
    });

    if (latestCustomRequestRef.current !== requestId) return;

    if (!result.ok || result.models.length === 0) {
      setCustomModels([]);
      setSelectedModels([]);
      setCustomModelStatus("fallback");
      setCustomModelMessage(result.ok ? CUSTOM_MODELS_FALLBACK_HINT : `${CUSTOM_MODELS_FALLBACK_HINT}：${result.error}`);
      latestResolvedSignatureRef.current = "";
      return;
    }

    setCustomModels(result.models);
    setCustomModelStatus("loaded");
    setCustomModelMessage("");
    latestResolvedSignatureRef.current = signature;
    setSelectedModels((prev) => {
      const next = prev.filter((id) => result.models.some((model) => model.id === id));
      return next.length > 0 ? next : [result.models[0].id];
    });
  }, [apiKey, baseUrl, customModels.length, fetchCustomModels, isCustom, resetCustomModels]);

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    setError("");

    const normalizedApiKey = apiKey.trim();
    const normalizedBaseUrl = baseUrl.trim();
    const normalizedManualModels = normalizeCustomModelInput(manualModelsInput);
    const models = isCustom && customModelStatus === "fallback"
      ? normalizedManualModels
      : selectedModels;

    if (models.length === 0 || !normalizedApiKey) {
      setError(isCustom && customModelStatus === "fallback"
        ? "请输入至少一个模型名并填写 API Key"
        : "Select at least one model and enter an API Key");
      return;
    }
    if (isCustom && !normalizedBaseUrl) {
      setError("Base URL is required for custom providers");
      return;
    }

    setAdding(true);
    const result = await onAdd({
      provider,
      models,
      apiKey: normalizedApiKey,
      baseUrl: isCustom ? normalizedBaseUrl : undefined,
      label: label.trim() || undefined,
      priority: Number.parseInt(priority, 10) || 0,
      maxRetries: Math.max(0, Number.parseInt(maxRetries, 10) || 0),
    });
    setAdding(false);
    if (result.ok) {
      setSelectedModels([]);
      setApiKey("");
      setBaseUrl("");
      setLabel("");
      setPriority("0");
      setMaxRetries("2");
      setManualModelsInput("");
      resetCustomModels();
    } else {
      setError(result.error || "Failed to add key");
    }
  };

  return (
    <form onSubmit={handleSubmit} class="flex flex-col gap-3 p-4 bg-white dark:bg-card-dark border border-gray-200 dark:border-border-dark rounded-xl">
      <div class="flex flex-wrap gap-3">
        <div class="flex flex-col gap-1 min-w-[140px]">
          <label class="text-[0.7rem] font-medium text-slate-500 dark:text-text-dim">上游类型</label>
          <select
            value={provider}
            onChange={(e) => {
              const v = (e.target as HTMLSelectElement).value as ApiKeyProvider;
              setProvider(v);
              setSelectedModels([]);
              setBaseUrl("");
              setApiKey("");
              setLabel("");
              setManualModelsInput("");
              latestResolvedSignatureRef.current = "";
              resetCustomModels();
            }}
            class="px-2.5 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-border-dark bg-slate-50 dark:bg-bg-dark text-slate-800 dark:text-text-main"
          >
            {PROVIDER_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>

        <div class="flex flex-col gap-1 flex-1 min-w-[200px]">
          <label class="text-[0.7rem] font-medium text-slate-500 dark:text-text-dim">上游密钥</label>
          <input
            type="password"
            value={apiKey}
            onInput={(e) => {
              setApiKey((e.target as HTMLInputElement).value);
              if (isCustom) {
                latestResolvedSignatureRef.current = "";
                resetCustomModels();
              }
            }}
            placeholder="sk-..."
            class="px-2.5 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-border-dark bg-slate-50 dark:bg-bg-dark text-slate-800 dark:text-text-main"
          />
        </div>
      </div>

      <div class="flex flex-col gap-1">
        <label class="text-[0.7rem] font-medium text-slate-500 dark:text-text-dim">可用模型</label>
        {!isCustom && renderModelChecklist(providerCatalog, selectedModelSet, handleModelToggle)}
        {isCustom && customModelStatus === "loaded" && renderModelChecklist(customModels, selectedModelSet, handleModelToggle)}
        {isCustom && customModelStatus !== "loaded" && (
          <div class="flex flex-col gap-2">
            <div class="px-2.5 py-2 text-sm rounded-lg border border-dashed border-gray-200 dark:border-border-dark text-slate-400 dark:text-text-dim">
              {customModelStatus === "loading" ? "正在获取模型列表..." : customModelMessage}
            </div>
            {customModelStatus === "fallback" && (
              <input
                type="text"
                value={manualModelsInput}
                onInput={(e) => setManualModelsInput((e.target as HTMLInputElement).value)}
                placeholder="model-name-1, model-name-2"
                class="px-2.5 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-border-dark bg-slate-50 dark:bg-bg-dark text-slate-800 dark:text-text-main"
              />
            )}
          </div>
        )}
      </div>

      {isCustom && (
        <div class="flex flex-col gap-1">
          <label class="text-[0.7rem] font-medium text-slate-500 dark:text-text-dim">上游地址</label>
          <input
            type="url"
            value={baseUrl}
            onInput={(e) => {
              setBaseUrl((e.target as HTMLInputElement).value);
              latestResolvedSignatureRef.current = "";
              resetCustomModels();
            }}
            onBlur={() => { void triggerCustomModelFetch(); }}
            placeholder="https://api.example.com/v1"
            class="px-2.5 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-border-dark bg-slate-50 dark:bg-bg-dark text-slate-800 dark:text-text-main"
          />
        </div>
      )}

      <div class="flex gap-3 items-end">
        <div class="flex flex-col gap-1 flex-1">
          <label class="text-[0.7rem] font-medium text-slate-500 dark:text-text-dim">上游名称</label>
          <input
            type="text"
            value={label}
            onInput={(e) => setLabel((e.target as HTMLInputElement).value)}
            placeholder="例如：主线路、备用线路、Team A"
            class="px-2.5 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-border-dark bg-slate-50 dark:bg-bg-dark text-slate-800 dark:text-text-main"
          />
        </div>
        <div class="flex flex-col gap-1 w-24">
          <label class="text-[0.7rem] font-medium text-slate-500 dark:text-text-dim">优先级</label>
          <input
            type="number"
            value={priority}
            onInput={(e) => setPriority((e.target as HTMLInputElement).value)}
            class="px-2.5 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-border-dark bg-slate-50 dark:bg-bg-dark text-slate-800 dark:text-text-main"
          />
        </div>
        <div class="flex flex-col gap-1 w-24">
          <label class="text-[0.7rem] font-medium text-slate-500 dark:text-text-dim">重试次数</label>
          <input
            type="number"
            min="0"
            max="10"
            value={maxRetries}
            onInput={(e) => setMaxRetries((e.target as HTMLInputElement).value)}
            class="px-2.5 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-border-dark bg-slate-50 dark:bg-bg-dark text-slate-800 dark:text-text-main"
          />
        </div>
        <button
          type="submit"
          disabled={adding}
          class="px-4 py-1.5 text-sm font-medium text-white bg-primary-action hover:bg-primary-action-hover rounded-lg transition-colors disabled:opacity-40 whitespace-nowrap"
        >
          {adding ? "添加中..." : "添加上游"}
        </button>
      </div>

      {error && <p class="text-xs text-red-500">{error}</p>}
    </form>
  );
}

export { AddKeyForm };

function providerBadgeColor(provider: ApiKeyProvider): string {
  switch (provider) {
    case "anthropic": return "bg-warning-container text-warning";
    case "openai": return "bg-success-container text-success";
    case "gemini": return "bg-info-container text-info";
    case "openrouter": return "bg-avatar-purple-bg text-avatar-purple-text";
    default: return "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400";
  }
}

function KeyRow({ entry, usage, usageLoading, onDelete, onToggle, onUpdateRouting, onUpdateBaseUrl, onRevealApiKey, onRefreshModels, onAddModels, onRemoveModels }: {
  entry: GroupedApiKeyEntry;
  usage: AggregatedUpstreamUsage | null;
  usageLoading: boolean;
  onDelete: (id: string) => void;
  onToggle: (id: string, status: "active" | "disabled") => void;
  onUpdateRouting: (id: string, routing: { priority?: number; maxRetries?: number }) => Promise<void>;
  onUpdateBaseUrl: (id: string, baseUrl: string) => Promise<void>;
  onRevealApiKey: (id: string) => Promise<{ ok: true; apiKey: string } | { ok: false; error: string }>;
  onRefreshModels: (id: string) => Promise<{ ok: true; models: string[] } | { ok: false; error: string }>;
  onAddModels: (id: string, models: string[]) => Promise<{ ok: boolean; error?: string }>;
  onRemoveModels: (id: string, models: string[]) => Promise<{ ok: boolean; error?: string }>;
}) {
  const isActive = entry.status === "active";
  const [expanded, setExpanded] = useState(false);
  const [priority, setPriority] = useState(String(entry.priority));
  const [maxRetries, setMaxRetries] = useState(String(entry.maxRetries));
  const [baseUrl, setBaseUrl] = useState(entry.baseUrl);
  const [apiKey, setApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [revealingApiKey, setRevealingApiKey] = useState(false);
  const [modelInput, setModelInput] = useState("");
  const [modelsBusy, setModelsBusy] = useState(false);
  const [modelMessage, setModelMessage] = useState<string | null>(null);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [selectedAvailableModels, setSelectedAvailableModels] = useState<string[]>([]);
  const [usageExpanded, setUsageExpanded] = useState(false);
  const baseUrlTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const priorityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const maxRetriesTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const displayName = entry.label?.trim() || entry.provider;
  const mainModels = entry.models.length > 0 ? entry.models : entry.model ? [entry.model] : [];
  const apiKeyValue = showApiKey ? apiKey : (entry.apiKeyMasked || "******");
  const normalizedPriority = Number.parseInt(priority, 10) || 0;
  const normalizedMaxRetries = Math.max(0, Number.parseInt(maxRetries, 10) || 0);

  useEffect(() => {
    setBaseUrl(entry.baseUrl);
  }, [entry.baseUrl]);

  useEffect(() => {
    setPriority(String(entry.priority));
  }, [entry.priority]);

  useEffect(() => {
    setMaxRetries(String(entry.maxRetries));
  }, [entry.maxRetries]);

  useEffect(() => () => {
    if (baseUrlTimerRef.current) clearTimeout(baseUrlTimerRef.current);
    if (priorityTimerRef.current) clearTimeout(priorityTimerRef.current);
    if (maxRetriesTimerRef.current) clearTimeout(maxRetriesTimerRef.current);
  }, []);

  const persistBaseUrl = useCallback(() => {
    const next = baseUrl.trim();
    const current = entry.baseUrl.trim();
    if (next === current) return;
    void onUpdateBaseUrl(entry.id, next);
  }, [baseUrl, entry.baseUrl, entry.id, onUpdateBaseUrl]);

  const persistPriority = useCallback(() => {
    if (normalizedPriority === entry.priority) return;
    void onUpdateRouting(entry.id, { priority: normalizedPriority });
  }, [entry.id, entry.priority, normalizedPriority, onUpdateRouting]);

  const persistMaxRetries = useCallback(() => {
    if (normalizedMaxRetries === entry.maxRetries) return;
    void onUpdateRouting(entry.id, { maxRetries: normalizedMaxRetries });
  }, [entry.id, entry.maxRetries, normalizedMaxRetries, onUpdateRouting]);

  const scheduleBaseUrlPersist = useCallback((value: string) => {
    setBaseUrl(value);
    if (baseUrlTimerRef.current) clearTimeout(baseUrlTimerRef.current);
    baseUrlTimerRef.current = setTimeout(() => {
      baseUrlTimerRef.current = null;
      const next = value.trim();
      const current = entry.baseUrl.trim();
      if (next === current) return;
      void onUpdateBaseUrl(entry.id, next);
    }, 500);
  }, [entry.baseUrl, entry.id, onUpdateBaseUrl]);

  const schedulePriorityPersist = useCallback((value: string) => {
    setPriority(value);
    if (priorityTimerRef.current) clearTimeout(priorityTimerRef.current);
    priorityTimerRef.current = setTimeout(() => {
      priorityTimerRef.current = null;
      const next = Number.parseInt(value, 10) || 0;
      if (next === entry.priority) return;
      void onUpdateRouting(entry.id, { priority: next });
    }, 350);
  }, [entry.id, entry.priority, onUpdateRouting]);

  const scheduleMaxRetriesPersist = useCallback((value: string) => {
    setMaxRetries(value);
    if (maxRetriesTimerRef.current) clearTimeout(maxRetriesTimerRef.current);
    maxRetriesTimerRef.current = setTimeout(() => {
      maxRetriesTimerRef.current = null;
      const next = Math.max(0, Number.parseInt(value, 10) || 0);
      if (next === entry.maxRetries) return;
      void onUpdateRouting(entry.id, { maxRetries: next });
    }, 350);
  }, [entry.id, entry.maxRetries, onUpdateRouting]);

  const handleToggleApiKeyVisibility = async () => {
    if (showApiKey) {
      setShowApiKey(false);
      setApiKey("");
      return;
    }

    setRevealingApiKey(true);
    const result = await onRevealApiKey(entry.id);
    setRevealingApiKey(false);
    if (!result.ok) return;
    setApiKey(result.apiKey);
    setShowApiKey(true);
  };

  const handleRefreshModels = async () => {
    setModelsBusy(true);
    setModelMessage(null);
    const result = await onRefreshModels(entry.id);
    setModelsBusy(false);
    if (!result.ok) {
      setModelMessage(result.error || "加载模型失败");
      return;
    }
    setAvailableModels(result.models);
    setSelectedAvailableModels(result.models.filter((model) => !mainModels.includes(model)));
    setModelMessage(`已加载上游模型，共 ${result.models.length} 个`);
  };

  const handleAddModels = async () => {
    const manualModels = normalizeCustomModelInput(modelInput);
    const models = [...new Set([...selectedAvailableModels, ...manualModels])].filter((model) => !mainModels.includes(model));
    if (models.length === 0) {
      setModelMessage("请选择或输入至少一个新模型");
      return;
    }
    setModelsBusy(true);
    setModelMessage(null);
    const result = await onAddModels(entry.id, models);
    setModelsBusy(false);
    if (result.ok) {
      setModelInput("");
      setSelectedAvailableModels([]);
      setModelMessage("模型已添加");
      return;
    }
    setModelMessage(result.error || "新增模型失败");
  };

  const handleRemoveModel = async (model: string) => {
    if (mainModels.length <= 1) {
      setModelMessage("至少保留一个模型");
      return;
    }
    setModelsBusy(true);
    setModelMessage(null);
    const result = await onRemoveModels(entry.id, [model]);
    setModelsBusy(false);
    if (result.ok) {
      setModelMessage("模型已删除");
      return;
    }
    setModelMessage(result.error || "删除模型失败");
  };

  const toggleAvailableModel = (model: string) => {
    if (mainModels.includes(model)) return;
    setSelectedAvailableModels((prev) => prev.includes(model)
      ? prev.filter((item) => item !== model)
      : [...prev, model]);
  };

  return (
    <div class={`flex flex-col gap-3 px-4 py-3 bg-white dark:bg-card-dark border border-gray-200 dark:border-border-dark rounded-xl transition-opacity ${!isActive ? "opacity-50" : ""}`}>
      <div class="flex items-center gap-2">
        <span class={`text-[0.65rem] font-semibold uppercase px-1.5 py-0.5 rounded ${providerBadgeColor(entry.provider)}`}>
          {entry.provider}
        </span>
        <span class="text-sm font-medium text-slate-700 dark:text-text-main">
          {displayName}
        </span>
        <div class="ml-auto flex items-center gap-2">
          <button
            onClick={() => setExpanded((value) => !value)}
            title={expanded ? "收起模型" : "查看模型"}
            class="px-2 py-1 text-xs rounded-md border border-gray-200 dark:border-border-dark text-slate-500 dark:text-text-dim hover:text-primary hover:border-primary/30 transition-colors"
          >
            {expanded ? `收起模型 (${mainModels.length})` : `查看模型 (${mainModels.length})`}
          </button>
          <button
            onClick={() => setUsageExpanded((value) => !value)}
            title={usageExpanded ? "收起用量" : "查看用量"}
            class="px-2 py-1 text-xs rounded-md border border-gray-200 dark:border-border-dark text-slate-500 dark:text-text-dim hover:text-primary hover:border-primary/30 transition-colors"
          >
            {usageExpanded ? "收起用量" : "查看用量"}
          </button>
          <button
            onClick={() => onToggle(entry.id, isActive ? "disabled" : "active")}
            title={isActive ? "禁用上游" : "启用上游"}
            aria-checked={isActive}
            role="switch"
            class={`relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none cursor-pointer ${isActive ? "bg-primary-action" : "bg-slate-300 dark:bg-slate-600"
              }`}
          >
            <span
              class={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white dark:bg-slate-200 shadow transform transition-transform duration-200 ${isActive ? "translate-x-4" : "translate-x-0"
                }`}
            />
          </button>

          <button
            onClick={() => onDelete(entry.id)}
            title="删除上游"
            class="p-1 text-slate-400 hover:text-red-500 transition-colors"
          >
            <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.108 0 0 0-7.5 0" />
            </svg>
          </button>
        </div>
      </div>

      <div class="grid gap-3 md:grid-cols-[11rem_minmax(0,1.6fr)_minmax(0,1fr)_96px_96px]">
        <div class="flex flex-col gap-1">
          <label class="text-[0.7rem] font-medium text-slate-500 dark:text-text-dim">上游名称</label>
          <input
            type="text"
            value={displayName}
            readOnly
            class="w-full px-2.5 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-border-dark bg-slate-100 dark:bg-bg-dark text-slate-700 dark:text-text-main cursor-default"
          />
        </div>

        <div class="flex flex-col gap-1">
          <label class="text-[0.7rem] font-medium text-slate-500 dark:text-text-dim">上游地址</label>
          <input
            type="url"
            value={baseUrl}
            onInput={(e) => scheduleBaseUrlPersist((e.target as HTMLInputElement).value)}
            onBlur={persistBaseUrl}
            class="w-full px-2.5 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-border-dark bg-slate-50 dark:bg-bg-dark text-slate-800 dark:text-text-main"
          />
        </div>

        <div class="flex flex-col gap-1">
          <label class="text-[0.7rem] font-medium text-slate-500 dark:text-text-dim">上游密钥</label>
          <div class="flex items-center gap-2">
            <input
              type="text"
              value={apiKeyValue}
              readOnly
              class="w-full px-2.5 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-border-dark bg-slate-100 dark:bg-bg-dark text-slate-700 dark:text-text-main font-mono cursor-default"
            />
            <button
              type="button"
              onClick={() => void handleToggleApiKeyVisibility()}
              disabled={revealingApiKey}
              title={showApiKey ? "隐藏密钥" : "显示密钥"}
              class="inline-flex items-center justify-center p-2 rounded-lg border border-gray-200 dark:border-border-dark text-slate-500 dark:text-text-dim hover:text-primary hover:border-primary/30 transition-colors disabled:opacity-40"
            >
              {showApiKey ? (
                <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M3.98 8.223A10.477 10.477 0 0 0 1.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.955-.138 2.867-.395m3.087-1.578A10.45 10.45 0 0 0 22.066 12C20.774 7.662 16.756 4.5 12 4.5c-1.113 0-2.183.173-3.188.495M6.228 6.228 3 3m3.228 3.228 3.65 3.65m0 0a3 3 0 1 0 4.243 4.243m-4.243-4.243L14.12 14.12m0 0 3.652 3.652M14.12 14.12 9.88 9.88" />
                </svg>
              ) : (
                <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M2.036 12.322a1.012 1.012 0 0 1 0-.644C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.21.07.437 0 .644C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.964-7.178Z" />
                  <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                </svg>
              )}
            </button>
          </div>
        </div>

        <div class="flex flex-col gap-1">
          <label class="text-[0.7rem] font-medium text-slate-500 dark:text-text-dim">优先级</label>
          <input
            type="number"
            value={priority}
            onInput={(e) => schedulePriorityPersist((e.target as HTMLInputElement).value)}
            onBlur={persistPriority}
            class="w-full px-2.5 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-border-dark bg-slate-50 dark:bg-bg-dark text-slate-800 dark:text-text-main"
          />
        </div>

        <div class="flex flex-col gap-1">
          <label class="text-[0.7rem] font-medium text-slate-500 dark:text-text-dim">重试次数</label>
          <input
            type="number"
            min="0"
            max="10"
            value={maxRetries}
            onInput={(e) => scheduleMaxRetriesPersist((e.target as HTMLInputElement).value)}
            onBlur={persistMaxRetries}
            class="w-full px-2.5 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-border-dark bg-slate-50 dark:bg-bg-dark text-slate-800 dark:text-text-main"
          />
        </div>
      </div>

      {usageExpanded && (
        <div class="flex flex-col gap-3 rounded-xl border border-gray-200 dark:border-border-dark bg-slate-50 dark:bg-bg-dark px-4 py-3">
          <div class="flex items-center justify-between gap-2">
            <div>
              <div class="text-sm font-medium text-slate-700 dark:text-text-main">上游用量</div>
              <div class="text-xs text-slate-400 dark:text-text-dim">
                最近更新时间：{usageLoading ? "Loading..." : formatUsageUpdatedAt(usage?.updated_at ?? null)}
              </div>
            </div>
          </div>

          {usageLoading ? (
            <div class="text-sm text-slate-400 dark:text-text-dim">Loading...</div>
          ) : usage ? (
            <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
              <UsageMetricCard label="输入 Tokens" value={formatNumber(usage.input_tokens)} />
              <UsageMetricCard label="输出 Tokens" value={formatNumber(usage.output_tokens)} />
              <UsageMetricCard label="缓存 Tokens" value={formatNumber(usage.cached_tokens)} />
              <UsageMetricCard
                label="图片 Tokens"
                value={`${formatNumber(usage.image_input_tokens)} / ${formatNumber(usage.image_output_tokens)}`}
              />
              <UsageMetricCard label="请求数" value={formatNumber(usage.request_count)} />
              <UsageMetricCard
                label="命中率"
                value={usage.input_tokens > 0 ? `${Math.round((usage.cached_tokens / usage.input_tokens) * 1000) / 10}%` : "0%"}
              />
            </div>
          ) : (
            <div class="text-sm text-slate-400 dark:text-text-dim">这个上游暂时还没有用量记录。</div>
          )}
        </div>
      )}

      {expanded && (
        <div class="flex flex-col gap-1">
          <div class="flex items-center gap-2">
            <label class="text-[0.7rem] font-medium text-slate-500 dark:text-text-dim">模型列表</label>
            <button
              type="button"
              onClick={() => void handleRefreshModels()}
              disabled={modelsBusy}
              class="px-2 py-1 text-xs rounded-md border border-gray-200 dark:border-border-dark text-slate-500 dark:text-text-dim hover:text-primary hover:border-primary/30 transition-colors disabled:opacity-40"
            >
              加载模型
            </button>
          </div>
          <div class="flex flex-wrap gap-2 rounded-lg border border-gray-200 dark:border-border-dark bg-slate-50 dark:bg-bg-dark px-3 py-2">
            {mainModels.map((model) => (
              <span
                key={model}
                class="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md bg-white dark:bg-card-dark border border-gray-200 dark:border-border-dark text-slate-700 dark:text-text-main font-mono"
              >
                <span>{model}</span>
                <button
                  type="button"
                  onClick={() => void handleRemoveModel(model)}
                  disabled={modelsBusy}
                  title="删除模型"
                  class="inline-flex items-center justify-center text-slate-400 hover:text-red-500 disabled:opacity-40"
                >
                  <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" />
                  </svg>
                </button>
              </span>
            ))}
          </div>
          {availableModels.length > 0 && (
            <div class="flex flex-col gap-1">
              <label class="text-[0.7rem] font-medium text-slate-500 dark:text-text-dim">上游模型候选</label>
              <div class="max-h-56 overflow-y-auto rounded-lg border border-gray-200 dark:border-border-dark bg-slate-50 dark:bg-bg-dark p-2 flex flex-col gap-1">
                {availableModels.map((model) => {
                  const alreadyAdded = mainModels.includes(model);
                  return (
                    <label key={model} class={`flex items-center gap-2 px-2 py-1 rounded text-sm ${alreadyAdded ? "text-slate-400 dark:text-slate-500" : "text-slate-800 dark:text-text-main hover:bg-white/70 dark:hover:bg-card-dark/70"}`}>
                      <input
                        type="checkbox"
                        checked={alreadyAdded || selectedAvailableModels.includes(model)}
                        disabled={alreadyAdded}
                        onChange={() => toggleAvailableModel(model)}
                      />
                      <span class="font-mono">{model}</span>
                      {alreadyAdded && <span class="ml-auto text-[10px]">已添加</span>}
                    </label>
                  );
                })}
              </div>
            </div>
          )}
          <div class="flex flex-col gap-2 md:flex-row">
            <input
              type="text"
              value={modelInput}
              onInput={(e) => setModelInput((e.target as HTMLInputElement).value)}
              placeholder="新增模型，支持逗号分隔"
              class="flex-1 px-2.5 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-border-dark bg-slate-50 dark:bg-bg-dark text-slate-800 dark:text-text-main"
            />
            <button
              type="button"
              onClick={() => void handleAddModels()}
              disabled={modelsBusy}
              class="px-3 py-1.5 text-sm rounded-lg bg-primary-action text-white hover:bg-primary-action-hover transition-colors disabled:opacity-40"
            >
              新增模型
            </button>
          </div>
          {modelMessage && (
            <div class="text-xs text-slate-500 dark:text-text-dim">{modelMessage}</div>
          )}
        </div>
      )}
    </div>
  );
}

function UsageMetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div class="rounded-lg border border-gray-200 dark:border-border-dark bg-white dark:bg-card-dark px-3 py-3">
      <div class="text-[11px] text-slate-500 dark:text-text-dim mb-1">{label}</div>
      <div class="text-base font-semibold text-slate-800 dark:text-text-main">{value}</div>
    </div>
  );
}

export function ApiKeyManager() {
  const { keys, catalog, loading, addKey, deleteKey, toggleStatus, updateBaseUrl, revealApiKey, refreshEntryModels, addEntryModels, removeEntryModels, updateRouting, importKeys, exportKeys, fetchCustomModels } = useApiKeys();
  const { summary, loading: usageLoading } = useUsageSummary();
  const groupedKeys = useMemo(() => groupEntries(keys), [keys]);
  const [showForm, setShowForm] = useState(false);
  const [importResult, setImportResult] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const pendingPersistRef = useRef(new Set<Promise<void>>());

  const trackPersist = useCallback((promise: Promise<void>) => {
    pendingPersistRef.current.add(promise);
    promise.finally(() => {
      pendingPersistRef.current.delete(promise);
    });
    return promise;
  }, []);

  const handleUpdateBaseUrl = useCallback((id: string, baseUrl: string) => {
    return trackPersist(updateBaseUrl(id, baseUrl));
  }, [trackPersist, updateBaseUrl]);

  const handleUpdateRouting = useCallback((id: string, routing: { priority?: number; maxRetries?: number }) => {
    return trackPersist(updateRouting(id, routing));
  }, [trackPersist, updateRouting]);

  const handleImport = useCallback(async () => {
    const files = fileRef.current?.files;
    if (!files || files.length === 0) return;
    try {
      const result = await importKeys(files[0]);
      setImportResult(`导入成功 ${result.added} 条，失败 ${result.failed} 条`);
      setTimeout(() => setImportResult(null), 5000);
    } catch {
      setImportResult("导入失败");
    }
    if (fileRef.current) fileRef.current.value = "";
  }, [importKeys]);

  const handleExport = useCallback(async () => {
    try {
      const activeElement = document.activeElement;
      if (activeElement instanceof HTMLElement) {
        activeElement.blur();
      }
      await Promise.resolve();
      const pending = [...pendingPersistRef.current];
      if (pending.length > 0) {
        await Promise.allSettled(pending);
      }
      await exportKeys();
      setImportResult("导出成功");
    } catch {
      setImportResult("导出失败");
    }
    setTimeout(() => setImportResult(null), 5000);
  }, [exportKeys]);

  if (loading) {
    return <div class="text-sm text-slate-400 dark:text-text-dim animate-pulse">正在加载中转上游服务商...</div>;
  }

  return (
    <div class="flex flex-col gap-3">
      <div class="flex items-center gap-2">
        <h2 class="text-sm font-semibold text-slate-700 dark:text-text-main flex items-center gap-2">
          <svg class="size-4 text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M15.75 5.25a3 3 0 0 1 3 3m3 0a6 6 0 0 1-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1 1 21.75 8.25Z" />
          </svg>
          上游服务商管理
          <span class="text-xs font-normal text-slate-400 dark:text-text-dim">
            ({groupedKeys.length})
          </span>
        </h2>

        <div class="ml-auto flex items-center gap-1">
          {importResult && (
            <span class="text-xs text-slate-500 dark:text-text-dim mr-2">{importResult}</span>
          )}

          <input ref={fileRef} type="file" accept=".json" onChange={handleImport} class="hidden" />
          <button
            onClick={() => void handleExport()}
            title="导出上游"
            class="p-1.5 text-slate-400 dark:text-text-dim hover:text-primary transition-colors rounded-md hover:bg-primary/10"
          >
            <svg class="size-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M7.5 10.5 12 6m0 0 4.5 4.5M12 6v13.5" />
            </svg>
          </button>
          <button
            onClick={() => fileRef.current?.click()}
            title="导入上游"
            class="p-1.5 text-slate-400 dark:text-text-dim hover:text-primary transition-colors rounded-md hover:bg-primary/10"
          >
            <svg class="size-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12M12 16.5V3" />
            </svg>
          </button>
          <button
            onClick={() => setShowForm(!showForm)}
            title="添加上游"
            class="p-1.5 text-slate-400 dark:text-text-dim hover:text-primary transition-colors rounded-md hover:bg-primary/10"
          >
            <svg class="size-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
          </button>
        </div>
      </div>

      {showForm && (
        <AddKeyForm
          onAdd={async (input) => {
            const result = await addKey(input);
            if (result.ok) setShowForm(false);
            return result;
          }}
          catalog={catalog}
          fetchCustomModels={fetchCustomModels}
        />
      )}

      {groupedKeys.length === 0 ? (
        <div class="text-center py-8 text-sm text-slate-400 dark:text-text-dim">
          还没有配置中转上游服务商，点击右上角加号添加。
        </div>
      ) : (
        <div class="flex flex-col gap-2">
          {groupedKeys.map((entry) => (
            <KeyRow
              key={entry.id}
              entry={entry}
              usage={aggregateUsageForEntry(entry, summary?.upstream_breakdown)}
              usageLoading={usageLoading}
              onDelete={deleteKey}
              onToggle={toggleStatus}
              onUpdateBaseUrl={handleUpdateBaseUrl}
              onRevealApiKey={revealApiKey}
              onRefreshModels={refreshEntryModels}
              onAddModels={addEntryModels}
              onRemoveModels={removeEntryModels}
              onUpdateRouting={handleUpdateRouting}
            />
          ))}
        </div>
      )}
    </div>
  );
}
