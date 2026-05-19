import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import { setPaths } from "../paths.js";
import { LogStore, queryRequestLog, readRequestLog } from "./store.js";

describe("LogStore", () => {
  let store: LogStore;
  let tmpDataDir: string;

  beforeEach(() => {
    tmpDataDir = mkdtempSync(resolve(tmpdir(), "codex-request-log-test-"));
    setPaths({
      rootDir: process.cwd(),
      configDir: resolve(process.cwd(), "config"),
      dataDir: tmpDataDir,
      binDir: resolve(process.cwd(), "bin"),
      publicDir: resolve(process.cwd(), "public"),
    });
    process.env.VITEST_FORCE_APPEND_REQUEST_LOG = "1";
    store = new LogStore(10);
  });

  afterEach(() => {
    delete process.env.VITEST_FORCE_APPEND_REQUEST_LOG;
    rmSync(tmpDataDir, { recursive: true, force: true });
  });

  it("returns newest records first when listing", async () => {
    store.enqueue({
      id: "1",
      requestId: "r1",
      direction: "ingress",
      ts: new Date().toISOString(),
      method: "POST",
      path: "/a",
    });
    store.enqueue({
      id: "2",
      requestId: "r2",
      direction: "ingress",
      ts: new Date().toISOString(),
      method: "POST",
      path: "/b",
    });

    await Promise.resolve();
    const result = store.list({ limit: 10, offset: 0 });
    expect(result.records.map((r) => r.id)).toEqual(["2", "1"]);
  });

  it("paginates from newest records first across pages", async () => {
    for (const id of ["1", "2", "3", "4"]) {
      store.enqueue({
        id,
        requestId: `r${id}`,
        direction: "ingress",
        ts: new Date().toISOString(),
        method: "POST",
        path: `/${id}`,
      });
    }

    await Promise.resolve();

    const page0 = store.list({ limit: 2, offset: 0 });
    const page1 = store.list({ limit: 2, offset: 2 });

    expect(page0.records.map((r) => r.id)).toEqual(["4", "3"]);
    expect(page1.records.map((r) => r.id)).toEqual(["2", "1"]);
  });

  it("filters by direction and search", async () => {
    store.enqueue({
      id: "1",
      requestId: "r1",
      direction: "ingress",
      ts: new Date().toISOString(),
      method: "POST",
      path: "/v1/messages",
      model: "claude",
    });
    store.enqueue({
      id: "2",
      requestId: "r2",
      direction: "egress",
      ts: new Date().toISOString(),
      method: "GET",
      path: "/health",
      provider: "codex",
    });

    await Promise.resolve();
    const filtered = store.list({ direction: "egress", search: "codex", limit: 10, offset: 0 });
    expect(filtered.total).toBe(1);
    expect(filtered.records.map((r) => r.id)).toEqual(["2"]);
  });

  it("normalizes invalid pagination values", async () => {
    store.enqueue({
      id: "1",
      requestId: "r1",
      direction: "ingress",
      ts: new Date().toISOString(),
      method: "POST",
      path: "/a",
    });

    await Promise.resolve();
    const result = store.list({ limit: Number.NaN, offset: Number.NaN });
    expect(result.limit).toBe(50);
    expect(result.offset).toBe(0);
  });

  it("redacts request payloads on flush", async () => {
    store.enqueue({
      id: "1",
      requestId: "r1",
      direction: "ingress",
      ts: new Date().toISOString(),
      method: "POST",
      path: "/a",
      request: {
        headers: { authorization: "Bearer secret" },
        nested: { token: "abc" },
      },
    });

    await Promise.resolve();
    const result = store.list({ limit: 10, offset: 0 });
    expect(result.records[0].request).toMatchObject({
      headers: { authorization: "Bea***et" },
      nested: { token: "***" },
    });
  });

  it("keeps cached token metadata on patched records", async () => {
    store.enqueue({
      id: "1",
      requestId: "r1",
      direction: "egress",
      ts: new Date().toISOString(),
      method: "POST",
      path: "/v1/responses",
    });

    await Promise.resolve();
    store.patchLatestByRequestId("r1", "egress", {
      inputTokens: 1200,
      outputTokens: 300,
      cachedTokens: 700,
      reasoningTokens: 80,
    });

    const result = store.list({ direction: "egress", limit: 10, offset: 0 });
    expect(result.records[0]).toMatchObject({
      inputTokens: 1200,
      outputTokens: 300,
      cachedTokens: 700,
      reasoningTokens: 80,
    });
  });

  it("updates persisted request logs when token metadata is patched", async () => {
    store.enqueue({
      id: "1",
      requestId: "r1",
      direction: "egress",
      ts: new Date().toISOString(),
      method: "POST",
      path: "/v1/responses",
      provider: "codex",
    });

    await Promise.resolve();
    store.patchLatestByRequestId("r1", "egress", {
      inputTokens: 1200,
      outputTokens: 300,
      cachedTokens: 700,
      reasoningTokens: 80,
    });

    expect(readRequestLog(10)[0]).toMatchObject({
      requestId: "r1",
      inputTokens: 1200,
      outputTokens: 300,
      cachedTokens: 700,
      reasoningTokens: 80,
    });
  });


  it("clears persisted request logs", async () => {
    store.enqueue({
      id: "1",
      requestId: "r1",
      direction: "egress",
      ts: new Date().toISOString(),
      method: "POST",
      path: "/v1/responses",
      provider: "codex",
    });

    await Promise.resolve();
    expect(readRequestLog(10)).toHaveLength(1);

    store.clear();

    expect(readRequestLog(10)).toHaveLength(0);
  });

  it("persists egress logs to request-log.jsonl", async () => {
    store.enqueue({
      id: "1",
      requestId: "r1",
      direction: "egress",
      ts: new Date().toISOString(),
      method: "POST",
      path: "/v1/responses",
      provider: "codex",
      request: { headers: { authorization: "Bearer secret" } },
    });
    store.enqueue({
      id: "2",
      requestId: "r2",
      direction: "ingress",
      ts: new Date().toISOString(),
      method: "POST",
      path: "/v1/responses",
    });

    await Promise.resolve();

    const file = resolve(tmpDataDir, "request-log.jsonl");
    expect(existsSync(file)).toBe(true);
    const lines = readFileSync(file, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const persisted = JSON.parse(lines[0]);
    expect(persisted).toMatchObject({ requestId: "r1", direction: "egress", provider: "codex" });
    expect(persisted.request.headers.authorization).toBe("Bea***et");
    expect(readRequestLog(10).map((record) => record.requestId)).toEqual(["r1"]);
    expect(queryRequestLog({ direction: "egress", search: "secret", limit: 10 }).records.map((record) => record.requestId)).toEqual([]);
    expect(queryRequestLog({ direction: "egress", search: "codex", limit: 10 }).records.map((record) => record.requestId)).toEqual(["r1"]);
  });

  it("trims existing records when capacity is lowered", async () => {
    for (const id of ["1", "2", "3", "4"]) {
      store.enqueue({
        id,
        requestId: `r${id}`,
        direction: "ingress",
        ts: new Date().toISOString(),
        method: "POST",
        path: `/${id}`,
      });
    }

    await Promise.resolve();

    const state = store.setState({ capacity: 2 });
    const result = store.list({ limit: 10, offset: 0 });

    expect(state.capacity).toBe(2);
    expect(state.size).toBe(2);
    expect(state.dropped).toBe(2);
    expect(result.records.map((r) => r.id)).toEqual(["4", "3"]);
  });
});
