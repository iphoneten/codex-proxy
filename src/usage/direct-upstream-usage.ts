import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "fs";
import { dirname, resolve } from "path";
import type { UsageInfo } from "../translation/codex-event-extractor.js";
import { getDataDir } from "../paths.js";

export interface DirectUpstreamUsageEntry {
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

interface DirectUpstreamUsageFile {
  version: 1;
  entries: DirectUpstreamUsageEntry[];
}

function getUsageFile(): string {
  return resolve(getDataDir(), "direct-upstream-usage.json");
}

function normalizeUsage(value: UsageInfo | undefined): UsageInfo {
  return {
    input_tokens: value?.input_tokens ?? 0,
    output_tokens: value?.output_tokens ?? 0,
    cached_tokens: value?.cached_tokens ?? 0,
    image_input_tokens: value?.image_input_tokens ?? 0,
    image_output_tokens: value?.image_output_tokens ?? 0,
  };
}

export class DirectUpstreamUsageStore {
  private entries = new Map<string, DirectUpstreamUsageEntry>();

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      const file = getUsageFile();
      if (!existsSync(file)) return;
      const raw = JSON.parse(readFileSync(file, "utf-8")) as DirectUpstreamUsageFile;
      if (!Array.isArray(raw.entries)) return;
      for (const entry of raw.entries) {
        if (!entry || typeof entry !== "object") continue;
        if (typeof entry.key !== "string" || typeof entry.provider !== "string") continue;
        this.entries.set(entry.key, {
          key: entry.key,
          provider: entry.provider,
          label: typeof entry.label === "string" ? entry.label : entry.provider,
          input_tokens: typeof entry.input_tokens === "number" ? entry.input_tokens : 0,
          output_tokens: typeof entry.output_tokens === "number" ? entry.output_tokens : 0,
          cached_tokens: typeof entry.cached_tokens === "number" ? entry.cached_tokens : 0,
          image_input_tokens: typeof entry.image_input_tokens === "number" ? entry.image_input_tokens : 0,
          image_output_tokens: typeof entry.image_output_tokens === "number" ? entry.image_output_tokens : 0,
          request_count: typeof entry.request_count === "number" ? entry.request_count : 0,
          updated_at: typeof entry.updated_at === "string" ? entry.updated_at : new Date(0).toISOString(),
        });
      }
    } catch {
      // ignore invalid stats file
    }
  }

  private persist(): void {
    try {
      const file = getUsageFile();
      const dir = dirname(file);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify({
        version: 1,
        entries: this.getBreakdown(),
      }, null, 2), "utf-8");
      renameSync(tmp, file);
    } catch (err) {
      console.error("[DirectUpstreamUsage] Failed to persist:", err instanceof Error ? err.message : err);
    }
  }

  record(key: string, provider: string, label: string, usage: UsageInfo | undefined): void {
    const normalized = normalizeUsage(usage);
    const now = new Date().toISOString();
    const existing = this.entries.get(key);
    if (existing) {
      existing.provider = provider;
      existing.label = label;
      existing.input_tokens += normalized.input_tokens;
      existing.output_tokens += normalized.output_tokens;
      existing.cached_tokens += normalized.cached_tokens ?? 0;
      existing.image_input_tokens += normalized.image_input_tokens ?? 0;
      existing.image_output_tokens += normalized.image_output_tokens ?? 0;
      existing.request_count += 1;
      existing.updated_at = now;
    } else {
      this.entries.set(key, {
        key,
        provider,
        label,
        input_tokens: normalized.input_tokens,
        output_tokens: normalized.output_tokens,
        cached_tokens: normalized.cached_tokens ?? 0,
        image_input_tokens: normalized.image_input_tokens ?? 0,
        image_output_tokens: normalized.image_output_tokens ?? 0,
        request_count: 1,
        updated_at: now,
      });
    }
    this.persist();
  }

  getBreakdown(): DirectUpstreamUsageEntry[] {
    return [...this.entries.values()]
      .map((entry) => ({ ...entry }))
      .sort((a, b) => {
        const byInput = b.input_tokens - a.input_tokens;
        if (byInput !== 0) return byInput;
        return a.label.localeCompare(b.label);
      });
  }
}

let singleton: DirectUpstreamUsageStore | null = null;

export function getDirectUpstreamUsageStore(): DirectUpstreamUsageStore {
  singleton ??= new DirectUpstreamUsageStore();
  return singleton;
}
