import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "fs";
import { resolve } from "path";
import { getDataDir } from "../paths.js";
import { redactJson } from "./redact.js";

export type LogDirection = "ingress" | "egress";

export interface LogRecord {
  id: string;
  requestId: string;
  direction: LogDirection;
  ts: string;
  method: string;
  path: string;
  model?: string | null;
  provider?: string | null;
  upstreamName?: string | null;
  status?: number | null;
  latencyMs?: number | null;
  stream?: boolean | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cachedTokens?: number | null;
  reasoningTokens?: number | null;
  sizeBytes?: number | null;
  error?: string | null;
  tags?: string[];
  request?: unknown;
  response?: unknown;
  meta?: Record<string, unknown>;
}

export interface LogState {
  enabled: boolean;
  paused: boolean;
  dropped: number;
  size: number;
  capacity: number;
}

interface LogStateUpdate {
  enabled?: boolean;
  paused?: boolean;
  capacity?: number;
}

export interface LogQuery {
  direction?: LogDirection | "all";
  search?: string | null;
  limit?: number;
  offset?: number;
}

const DEFAULT_CAPACITY = 2000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const REQUEST_LOG_FILE = "request-log.jsonl";
const REQUEST_LOG_BACKUP_FILE = "request-log.1.jsonl";
const REQUEST_LOG_MAX_BYTES = 10 * 1024 * 1024;

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(Math.max(1, Math.trunc(limit)), MAX_LIMIT);
}

function normalizeOffset(offset: number | undefined): number {
  if (offset === undefined || !Number.isFinite(offset)) return 0;
  return Math.max(0, Math.trunc(offset));
}

function ensureDataDir(): string {
  const dir = getDataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function requestLogPath(): string {
  return resolve(ensureDataDir(), REQUEST_LOG_FILE);
}

function requestLogBackupPath(): string {
  return resolve(ensureDataDir(), REQUEST_LOG_BACKUP_FILE);
}

function rotateRequestLogIfNeeded(): void {
  const current = requestLogPath();
  if (!existsSync(current)) return;
  if (statSync(current).size <= REQUEST_LOG_MAX_BYTES) return;
  const backup = requestLogBackupPath();
  if (existsSync(backup) && process.platform === "win32") {
    try { renameSync(backup, backup + ".old"); } catch { /* ignore */ }
  }
  renameSync(current, backup);
}

function appendRequestLog(record: LogRecord): void {
  if (process.env.VITEST && !process.env.VITEST_FORCE_APPEND_REQUEST_LOG) return;
  if (record.direction !== "egress") return;
  try {
    rotateRequestLogIfNeeded();
    appendFileSync(requestLogPath(), JSON.stringify(record) + "\n", "utf-8");
  } catch {
    // Audit log persistence is best-effort; in-memory logs still work.
  }
}

function rewriteRequestLogRecord(updated: LogRecord): void {
  if (process.env.VITEST && !process.env.VITEST_FORCE_APPEND_REQUEST_LOG) return;
  if (updated.direction !== "egress") return;

  const files = [requestLogPath(), requestLogBackupPath()];
  for (const file of files) {
    if (!existsSync(file)) continue;
    try {
      const lines = readFileSync(file, "utf-8").split("\n");
      let changed = false;
      const rewritten = lines.map((line) => {
        const trimmed = line.trim();
        if (!trimmed) return line;
        try {
          const record = JSON.parse(trimmed) as LogRecord;
          if (record.id !== updated.id) return line;
          changed = true;
          return JSON.stringify(updated);
        } catch {
          return line;
        }
      });
      if (changed) {
        writeFileSync(file, rewritten.join("\n"), "utf-8");
        return;
      }
    } catch {
      // Audit log persistence is best-effort; in-memory logs still work.
    }
  }
}

function readJsonlFile(path: string): LogRecord[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf-8");
  const out: LogRecord[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { out.push(JSON.parse(trimmed) as LogRecord); } catch { /* skip bad lines */ }
  }
  return out;
}

function searchMatches(record: LogRecord, search: string): boolean {
  if (!search) return true;
  const hay = [
    record.id,
    record.requestId,
    record.direction,
    record.method,
    record.path,
    record.model ?? "",
    record.provider ?? "",
    record.upstreamName ?? "",
    record.status ?? "",
    record.error ?? "",
    JSON.stringify(record.request ?? ""),
    JSON.stringify(record.response ?? ""),
  ].join(" ").toLowerCase();
  return hay.includes(search);
}

function applyLogQuery(records: LogRecord[], query: LogQuery): { records: LogRecord[]; total: number; offset: number; limit: number } {
  const direction = query.direction ?? "all";
  const search = (query.search ?? "").trim().toLowerCase();
  let results = records;

  if (direction !== "all") {
    results = results.filter((r) => r.direction === direction);
  }

  if (search) {
    results = results.filter((r) => searchMatches(r, search));
  }

  const total = results.length;
  const limit = normalizeLimit(query.limit);
  const offset = normalizeOffset(query.offset);
  const newestFirst = [...results].reverse();
  const sliced = newestFirst.slice(offset, offset + limit);

  return { records: sliced, total, offset, limit };
}

function readPersistedRequestLogs(query: LogQuery): { records: LogRecord[]; total: number; offset: number; limit: number } {
  const combined = [...readJsonlFile(requestLogBackupPath()), ...readJsonlFile(requestLogPath())];
  return applyLogQuery(combined, { ...query, direction: query.direction ?? "egress" });
}

export class LogStore {
  private records: LogRecord[] = [];
  private capacity: number;
  private enabled = true;
  private paused = false;
  private dropped = 0;
  private queue: LogRecord[] = [];
  private flushScheduled = false;

  constructor(capacity = DEFAULT_CAPACITY) {
    this.capacity = capacity;
  }

  getState(): LogState {
    return {
      enabled: this.enabled,
      paused: this.paused,
      dropped: this.dropped,
      size: this.records.length,
      capacity: this.capacity,
    };
  }

  setState(next: LogStateUpdate): LogState {
    if (typeof next.enabled === "boolean") {
      this.enabled = next.enabled;
      if (next.enabled) this.paused = false;
    }
    if (typeof next.paused === "boolean") this.paused = next.paused;
    if (typeof next.capacity === "number" && Number.isFinite(next.capacity)) {
      this.capacity = Math.max(1, Math.trunc(next.capacity));
      this.trimToCapacity();
    }
    return this.getState();
  }

  clear(): void {
    this.records = [];
    this.dropped = 0;
  }

  enqueue(record: LogRecord): void {
    if (!this.enabled || this.paused) return;
    this.queue.push(record);
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      queueMicrotask(() => this.flush());
    }
  }

  list(query: LogQuery): { records: LogRecord[]; total: number; offset: number; limit: number } {
    return applyLogQuery(this.records, query);
  }

  get(id: string): LogRecord | null {
    return this.records.find((r) => r.id === id) ?? null;
  }

  patchLatestByRequestId(requestId: string, direction: LogDirection, patch: Partial<LogRecord>): void {
    for (let index = this.records.length - 1; index >= 0; index--) {
      const record = this.records[index];
      if (record.requestId === requestId && record.direction === direction) {
        const updated = { ...record, ...patch };
        this.records[index] = updated;
        rewriteRequestLogRecord(updated);
        return;
      }
    }
  }

  private flush(): void {
    this.flushScheduled = false;
    if (!this.queue.length) return;

    const batch = this.queue.splice(0, this.queue.length);
    for (const record of batch) {
      const redacted: LogRecord = {
        ...record,
        request: record.request !== undefined ? redactJson(record.request) : undefined,
        response: record.response !== undefined ? redactJson(record.response) : undefined,
      };
      this.records.push(redacted);
      appendRequestLog(redacted);
    }

    this.trimToCapacity();
  }

  private trimToCapacity(): void {
    if (this.records.length <= this.capacity) return;
    const over = this.records.length - this.capacity;
    this.records.splice(0, over);
    this.dropped += over;
  }
}

export function queryRequestLog(query: LogQuery): { records: LogRecord[]; total: number; offset: number; limit: number } {
  return readPersistedRequestLogs(query);
}

export function readRequestLog(limit = DEFAULT_LIMIT): LogRecord[] {
  return queryRequestLog({ limit }).records;
}

export const logStore = new LogStore();
