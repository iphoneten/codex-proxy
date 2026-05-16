/**
 * ApiKeyPool — CRUD + persistence for third-party API keys.
 *
 * Each entry binds one upstream relay to one or more models.
 * Built-in providers (openai/anthropic/gemini) have default base URLs;
 * custom providers require a user-supplied base URL.
 */

import {
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  mkdirSync,
} from "fs";
import { resolve, dirname } from "path";
import { randomBytes } from "crypto";
import { getDataDir } from "../paths.js";
import type { ApiKeyProvider } from "./api-key-catalog.js";
import { isBuiltinProvider, PROVIDER_CATALOG } from "./api-key-catalog.js";

// ── Types ──────────────────────────────────────────────────────────

export type ApiKeyStatus = "active" | "disabled" | "error";

export interface ApiKeyEntry {
  id: string;
  provider: ApiKeyProvider;
  model?: string;
  models: string[];
  apiKey: string;
  baseUrl: string;
  label: string | null;
  priority: number;
  maxRetries: number;
  status: ApiKeyStatus;
  addedAt: string;
  lastUsedAt: string | null;
}

interface ApiKeysFile {
  keys: Array<ApiKeyEntry | LegacyApiKeyEntry>;
}

export interface ApiKeyPersistence {
  load(): Array<ApiKeyEntry | LegacyApiKeyEntry>;
  save(keys: ApiKeyEntry[]): void;
}

interface LegacyApiKeyEntry {
  id?: string;
  provider: ApiKeyProvider;
  model?: string;
  models?: string[];
  apiKey: string;
  baseUrl?: string;
  label?: string | null;
  priority?: number;
  maxRetries?: number;
  status?: ApiKeyStatus;
  addedAt?: string;
  lastUsedAt?: string | null;
}

// ── Persistence ────────────────────────────────────────────────────

function getApiKeysFile(): string {
  return resolve(getDataDir(), "api-keys.json");
}

export function createFsApiKeyPersistence(): ApiKeyPersistence {
  return {
    load(): ApiKeyEntry[] {
      try {
        const file = getApiKeysFile();
        if (!existsSync(file)) return [];
        const raw = readFileSync(file, "utf-8");
        const data = JSON.parse(raw) as ApiKeysFile;
    return normalizeLoadedEntries(Array.isArray(data.keys) ? data.keys : []);
  } catch {
        return [];
      }
    },
    save(keys: ApiKeyEntry[]): void {
      try {
        const file = getApiKeysFile();
        const dir = dirname(file);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        const data: ApiKeysFile = { keys };
        const tmp = file + ".tmp";
        writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
        renameSync(tmp, file);
      } catch (err) {
        console.error("[ApiKeyPool] Failed to persist:", err instanceof Error ? err.message : err);
      }
    },
  };
}

// ── Pool ───────────────────────────────────────────────────────────

export class ApiKeyPool {
  private entries: ApiKeyEntry[];
  private persistence: ApiKeyPersistence;

  constructor(persistence?: ApiKeyPersistence) {
    this.persistence = persistence ?? createFsApiKeyPersistence();
    this.entries = normalizeLoadedEntries(this.persistence.load());
  }

  // ── Query ──────────────────────────────────────────────────────

  getAll(): ApiKeyEntry[] {
    return [...this.entries];
  }

  getEntry(id: string): ApiKeyEntry | undefined {
    return this.entries.find((e) => e.id === id);
  }

  /** Get all active entries for a given model (exact match). */
  getByModel(model: string): ApiKeyEntry[] {
    return sortApiKeyEntries(
      this.entries.filter((e) => e.status === "active" && e.models.includes(model)),
    );
  }

  /** Get all active entries for a given provider. */
  getByProvider(provider: ApiKeyProvider): ApiKeyEntry[] {
    return sortApiKeyEntries(
      this.entries.filter((e) => e.provider === provider && e.status === "active"),
    );
  }

  /** Get unique active model IDs from runtime-managed API keys. */
  getActiveModels(): string[] {
    return [...new Set(
      this.entries
        .filter((e) => e.status === "active")
        .flatMap((e) => e.models),
    )];
  }

  /** Returns true if any active entry matches the given model ID. */
  hasActiveModel(modelId: string): boolean {
    return this.entries.some((e) => e.status === "active" && e.models.includes(modelId));
  }

  // ── Mutations ──────────────────────────────────────────────────

  add(input: {
    provider: ApiKeyProvider;
    model?: string;
    models?: string[];
    apiKey: string;
    baseUrl?: string;
    label?: string | null;
    priority?: number;
    maxRetries?: number;
  }): ApiKeyEntry {
    const models = normalizeModels(input.models ?? input.model);
    if (models.length === 0) throw new Error("At least one model is required");

    const baseUrl = input.baseUrl
      ?? (isBuiltinProvider(input.provider) ? PROVIDER_CATALOG[input.provider].defaultBaseUrl : "");

    const entry: ApiKeyEntry = {
      id: randomBytes(8).toString("hex"),
      provider: input.provider,
      models,
      model: models[0],
      apiKey: input.apiKey,
      baseUrl,
      label: input.label ?? null,
      priority: normalizePriority(input.priority),
      maxRetries: normalizeMaxRetries(input.maxRetries),
      status: "active",
      addedAt: new Date().toISOString(),
      lastUsedAt: null,
    };
    this.entries.push(entry);
    this.persist();
    return entry;
  }

  remove(id: string): boolean {
    const idx = this.entries.findIndex((e) => e.id === id);
    if (idx === -1) return false;
    this.entries.splice(idx, 1);
    this.persist();
    return true;
  }

  setLabel(id: string, label: string | null): boolean {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return false;
    entry.label = label;
    this.persist();
    return true;
  }

  setBaseUrl(id: string, baseUrl: string): boolean {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return false;
    entry.baseUrl = baseUrl.trim();
    this.persist();
    return true;
  }

  setApiKey(id: string, apiKey: string): boolean {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return false;
    entry.apiKey = apiKey.trim();
    this.persist();
    return true;
  }

  setRouting(id: string, routing: { priority?: number; maxRetries?: number }): boolean {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return false;
    if (routing.priority !== undefined) entry.priority = normalizePriority(routing.priority);
    if (routing.maxRetries !== undefined) entry.maxRetries = normalizeMaxRetries(routing.maxRetries);
    this.persist();
    return true;
  }

  addModels(id: string, models: string[]): boolean {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return false;
    const merged = normalizeModels([...entry.models, ...models]);
    if (merged.length === 0) return false;
    entry.models = merged;
    entry.model = merged[0];
    this.persist();
    return true;
  }

  removeModels(id: string, models: string[]): boolean {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return false;
    const toRemove = new Set(normalizeModels(models));
    if (toRemove.size === 0) return false;
    const remaining = entry.models.filter((model) => !toRemove.has(model));
    if (remaining.length === 0) return false;
    entry.models = remaining;
    entry.model = remaining[0];
    this.persist();
    return true;
  }

  setStatus(id: string, status: ApiKeyStatus): boolean {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return false;
    entry.status = status;
    this.persist();
    return true;
  }

  markUsed(id: string): void {
    const entry = this.entries.find((e) => e.id === id);
    if (entry) {
      entry.lastUsedAt = new Date().toISOString();
      // Defer persist — lastUsedAt is non-critical
    }
  }

  /** Bulk import — returns counts. */
  importMany(items: Array<{
    provider: ApiKeyProvider;
    model?: string;
    models?: string[];
    apiKey: string;
    baseUrl?: string;
    label?: string | null;
    priority?: number;
    maxRetries?: number;
  }>): { added: number; failed: number; errors: string[] } {
    let added = 0;
    const errors: string[] = [];

    for (const item of items) {
      try {
        this.add(item);
        added++;
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }

    return { added, failed: errors.length, errors };
  }

  /** Export all entries (masks API keys by default). */
  exportAll(unmask = false): ApiKeyEntry[] {
    return this.entries.map((e) => ({
      ...e,
      apiKey: unmask ? e.apiKey : maskKey(e.apiKey),
    }));
  }

  /** Export for re-import (full keys). */
  exportForReimport(): Array<{
    provider: ApiKeyProvider;
    models: string[];
    apiKey: string;
    baseUrl: string;
    label: string | null;
    priority: number;
    maxRetries: number;
  }> {
    return this.entries.map((e) => ({
      provider: e.provider,
      models: [...e.models],
      apiKey: e.apiKey,
      baseUrl: e.baseUrl,
      label: e.label,
      priority: e.priority,
      maxRetries: e.maxRetries,
    }));
  }

  persistNow(): void {
    this.persist();
  }

  // ── Internal ───────────────────────────────────────────────────

  private persist(): void {
    this.persistence.save(this.entries);
  }
}

function maskKey(key: string): string {
  if (key.length <= 8) return "****";
  return key.slice(0, 4) + "****" + key.slice(-4);
}

function normalizePriority(priority: number | undefined): number {
  if (!Number.isFinite(priority)) return 0;
  return Math.trunc(priority!);
}

function normalizeMaxRetries(maxRetries: number | undefined): number {
  if (!Number.isFinite(maxRetries)) return 2;
  return Math.max(0, Math.trunc(maxRetries!));
}

function normalizeApiKeyEntry(entry: ApiKeyEntry): ApiKeyEntry {
    return {
    ...entry,
    models: normalizeModels(entry.models),
    model: entry.model?.trim() || normalizeModels(entry.models)[0],
    priority: normalizePriority((entry as ApiKeyEntry & { priority?: number }).priority),
    maxRetries: normalizeMaxRetries((entry as ApiKeyEntry & { maxRetries?: number }).maxRetries),
  };
}

function normalizeLoadedEntries(entries: Array<ApiKeyEntry | LegacyApiKeyEntry>): ApiKeyEntry[] {
  const merged = new Map<string, ApiKeyEntry>();

  for (const rawEntry of entries) {
    const entry = normalizeLoadedEntry(rawEntry);
    if (!entry) continue;

    const mergeKey = [
      entry.provider,
      entry.apiKey,
      entry.baseUrl,
      entry.label ?? "",
      String(entry.priority),
      String(entry.maxRetries),
      entry.status,
    ].join("::");

    const existing = merged.get(mergeKey);
    if (!existing) {
      merged.set(mergeKey, entry);
      continue;
    }

    existing.models = normalizeModels([...existing.models, ...entry.models]);
    existing.addedAt = existing.addedAt.localeCompare(entry.addedAt) <= 0 ? existing.addedAt : entry.addedAt;
    if ((entry.lastUsedAt ?? "") > (existing.lastUsedAt ?? "")) {
      existing.lastUsedAt = entry.lastUsedAt;
    }
  }

  return [...merged.values()].map(normalizeApiKeyEntry);
}

function normalizeLoadedEntry(entry: ApiKeyEntry | LegacyApiKeyEntry): ApiKeyEntry | null {
  const provider = entry.provider;
  if (!provider) return null;

  const models = normalizeModels("models" in entry ? entry.models : undefined, "model" in entry ? entry.model : undefined);
  if (models.length === 0) return null;

  const baseUrl = entry.baseUrl
    ?? (isBuiltinProvider(provider) ? PROVIDER_CATALOG[provider].defaultBaseUrl : "");

  return {
    id: entry.id ?? randomBytes(8).toString("hex"),
    provider,
    model: models[0],
    models,
    apiKey: entry.apiKey,
    baseUrl,
    label: entry.label ?? null,
    priority: normalizePriority(entry.priority),
    maxRetries: normalizeMaxRetries(entry.maxRetries),
    status: entry.status ?? "active",
    addedAt: entry.addedAt ?? new Date().toISOString(),
    lastUsedAt: entry.lastUsedAt ?? null,
  };
}

function normalizeModels(...values: Array<string[] | string | undefined>): string[] {
  const models = values.flatMap((value) => Array.isArray(value) ? value : [value])
    .map((value) => typeof value === "string" ? value.trim() : "")
    .filter(Boolean);
  return [...new Set(models)];
}

function sortApiKeyEntries(entries: ApiKeyEntry[]): ApiKeyEntry[] {
  return [...entries].sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    const aLast = a.lastUsedAt ?? "";
    const bLast = b.lastUsedAt ?? "";
    if (aLast !== bLast) return aLast.localeCompare(bLast);
    return a.addedAt.localeCompare(b.addedAt);
  });
}
