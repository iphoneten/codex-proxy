import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { handleDirectRequest } from "@src/routes/shared/direct-request-handler.js";
import { CodexApiError } from "@src/proxy/codex-api.js";
import type { HandleDirectRequestOptions, ProxyRequest } from "@src/routes/shared/proxy-handler-types.js";
import { createMockFormatAdapter } from "@helpers/format-adapter.js";

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => ({ api: { timeout_seconds: 1 } })),
}));

function createDefaultRequest(): ProxyRequest {
  return {
    codexRequest: {
      model: "gpt-4o",
      instructions: "test",
      input: [{ role: "user", content: "hello" }],
      stream: true,
      store: false,
    },
    model: "gpt-4o",
    isStreaming: false,
  };
}

function makeUpstream(tag: string, impl: () => Promise<Response>) {
  return {
    tag,
    createResponse: vi.fn(impl),
    parseStream: vi.fn(async function* () {}),
  };
}

describe("handleDirectRequest fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("falls through to the next higher-order candidate after retries are exhausted", async () => {
    const first = makeUpstream("first", async () => {
      throw new CodexApiError(502, "bad gateway");
    });
    const second = makeUpstream("second", async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const fmt = createMockFormatAdapter();
    const req = createDefaultRequest();
    const app = new Hono();

    app.post("/test", (c) => handleDirectRequest({
      c,
      upstream: first as never,
      upstreamCandidates: [
        { adapter: first as never, entry: { id: "1", provider: "openai", model: "gpt-4o", models: ["gpt-4o"], apiKey: "a", baseUrl: "", label: null, priority: 10, maxRetries: 1, status: "active", addedAt: "", lastUsedAt: null } },
        { adapter: second as never, entry: { id: "2", provider: "openai", model: "gpt-4o", models: ["gpt-4o"], apiKey: "b", baseUrl: "", label: null, priority: 1, maxRetries: 0, status: "active", addedAt: "", lastUsedAt: null } },
      ],
      req,
      fmt,
    } satisfies HandleDirectRequestOptions));

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(200);
    expect(first.createResponse).toHaveBeenCalledTimes(2);
    expect(second.createResponse).toHaveBeenCalledTimes(1);
  });

  it("falls through to the next candidate on non-retryable direct upstream errors", async () => {
    const first = makeUpstream("first", async () => {
      throw new CodexApiError(400, "bad request");
    });
    const second = makeUpstream("second", async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const fmt = createMockFormatAdapter();
    const req = createDefaultRequest();
    const app = new Hono();

    app.post("/test", (c) => handleDirectRequest({
      c,
      upstream: first as never,
      upstreamCandidates: [
        { adapter: first as never, entry: { id: "1", provider: "openai", model: "gpt-4o", models: ["gpt-4o"], apiKey: "a", baseUrl: "", label: null, priority: 10, maxRetries: 0, status: "active", addedAt: "", lastUsedAt: null } },
        { adapter: second as never, entry: { id: "2", provider: "openai", model: "gpt-4o", models: ["gpt-4o"], apiKey: "b", baseUrl: "", label: null, priority: 1, maxRetries: 0, status: "active", addedAt: "", lastUsedAt: null } },
      ],
      req,
      fmt,
    } satisfies HandleDirectRequestOptions));

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(200);
    expect(first.createResponse).toHaveBeenCalledTimes(1);
    expect(second.createResponse).toHaveBeenCalledTimes(1);
  });

  it("honors the direct upstream retry count configured by the user", async () => {
    const first = makeUpstream("first", async () => {
      throw new CodexApiError(503, "temporarily unavailable");
    });
    const second = makeUpstream("second", async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const fmt = createMockFormatAdapter();
    const req = createDefaultRequest();
    const app = new Hono();

    app.post("/test", (c) => handleDirectRequest({
      c,
      upstream: first as never,
      upstreamCandidates: [
        { adapter: first as never, entry: { id: "1", provider: "openai", model: "gpt-4o", models: ["gpt-4o"], apiKey: "a", baseUrl: "", label: null, priority: 10, maxRetries: 10, status: "active", addedAt: "", lastUsedAt: null } },
        { adapter: second as never, entry: { id: "2", provider: "openai", model: "gpt-4o", models: ["gpt-4o"], apiKey: "b", baseUrl: "", label: null, priority: 1, maxRetries: 0, status: "active", addedAt: "", lastUsedAt: null } },
      ],
      req,
      fmt,
    } satisfies HandleDirectRequestOptions));

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(200);
    expect(first.createResponse).toHaveBeenCalledTimes(11);
    expect(second.createResponse).toHaveBeenCalledTimes(1);
  });

  it("retries 429 on the same direct upstream according to the configured retry count", async () => {
    const first = makeUpstream("first", async () => {
      throw new CodexApiError(429, "rate limited");
    });
    const second = makeUpstream("second", async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const fmt = createMockFormatAdapter();
    const req = createDefaultRequest();
    const app = new Hono();

    app.post("/test", (c) => handleDirectRequest({
      c,
      upstream: first as never,
      upstreamCandidates: [
        { adapter: first as never, entry: { id: "1", provider: "openai", model: "gpt-4o", models: ["gpt-4o"], apiKey: "a", baseUrl: "", label: null, priority: 10, maxRetries: 2, status: "active", addedAt: "", lastUsedAt: null } },
        { adapter: second as never, entry: { id: "2", provider: "openai", model: "gpt-4o", models: ["gpt-4o"], apiKey: "b", baseUrl: "", label: null, priority: 1, maxRetries: 0, status: "active", addedAt: "", lastUsedAt: null } },
      ],
      req,
      fmt,
    } satisfies HandleDirectRequestOptions));

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(200);
    expect(first.createResponse).toHaveBeenCalledTimes(3);
    expect(second.createResponse).toHaveBeenCalledTimes(1);
  });

  it("falls back to the next configured upstream model when the requested model is unsupported", async () => {
    const upstream = {
      tag: "first",
      createResponse: vi.fn(async (request: { model: string }) => {
        if (request.model === "gpt-5.4") {
          throw new CodexApiError(400, '{"detail":"Model not supported"}');
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
      parseStream: vi.fn(async function* () {}),
    };
    const fmt = createMockFormatAdapter();
    const req = createDefaultRequest();
    const app = new Hono();

    app.post("/test", (c) => handleDirectRequest({
      c,
      upstream: upstream as never,
      upstreamCandidates: [
        {
          adapter: upstream as never,
          resolvedModel: "gpt-5.4",
          entry: {
            id: "1",
            provider: "openai",
            model: "gpt-5.4",
            models: ["gpt-5.4", "gpt-5.5"],
            apiKey: "a",
            baseUrl: "",
            label: null,
            priority: 10,
            maxRetries: 0,
            status: "active",
            addedAt: "",
            lastUsedAt: null,
          },
        },
      ],
      req: {
        ...req,
        model: "codex",
        codexRequest: { ...req.codexRequest, model: "codex" },
      },
      fmt,
    } satisfies HandleDirectRequestOptions));

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(200);
    expect(upstream.createResponse).toHaveBeenCalledTimes(2);
    expect(upstream.createResponse).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ model: "gpt-5.4" }),
      expect.any(AbortSignal),
    );
    expect(upstream.createResponse).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ model: "gpt-5.5" }),
      expect.any(AbortSignal),
    );
  });

  it("uses the account-pool fallback after all direct upstream candidates fail", async () => {
    const upstream = makeUpstream("first", async () => {
      throw new CodexApiError(400, '{"detail":"Model not supported"}');
    });
    const fmt = createMockFormatAdapter();
    const req = createDefaultRequest();
    const fallbackToAccountPool = vi.fn(async () =>
      new Response(JSON.stringify({ fallback: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const app = new Hono();

    app.post("/test", (c) => handleDirectRequest({
      c,
      upstream: upstream as never,
      upstreamCandidates: [
        { adapter: upstream as never, resolvedModel: "gpt-5.5" },
      ],
      req,
      fmt,
      fallbackToAccountPool,
    } satisfies HandleDirectRequestOptions));

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ fallback: true });
    expect(fallbackToAccountPool).toHaveBeenCalledTimes(1);
    expect(upstream.createResponse).toHaveBeenCalledTimes(1);
  });

  it("uses the account-pool fallback when direct response collection fails", async () => {
    const upstream = makeUpstream("first", async () => new Response("not valid upstream output", { status: 200 }));
    const fmt = createMockFormatAdapter({
      collectTranslator: vi.fn(async () => {
        throw new Error("direct collect failed");
      }),
    });
    const req = createDefaultRequest();
    const fallbackToAccountPool = vi.fn(async () =>
      new Response(JSON.stringify({ fallback: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const app = new Hono();

    app.post("/test", (c) => handleDirectRequest({
      c,
      upstream: upstream as never,
      upstreamCandidates: [
        { adapter: upstream as never, resolvedModel: "gpt-5.5", entry: { id: "1", provider: "openai", model: "gpt-5.5", models: ["gpt-5.5"], apiKey: "a", baseUrl: "", label: null, priority: 10, maxRetries: 0, status: "active", addedAt: "", lastUsedAt: null } },
      ],
      req,
      fmt,
      fallbackToAccountPool,
    } satisfies HandleDirectRequestOptions));

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ fallback: true });
    expect(fallbackToAccountPool).toHaveBeenCalledTimes(1);
    expect(fmt.collectTranslator).toHaveBeenCalledTimes(1);
  });

  it("streams through the direct candidate that actually succeeded", async () => {
    const first = makeUpstream("first", async () => {
      throw new CodexApiError(502, "bad gateway");
    });
    const second = makeUpstream("second", async () => new Response("data: {}\n\n", { status: 200 }));
    const fmt = createMockFormatAdapter();
    const req = { ...createDefaultRequest(), isStreaming: true };
    const app = new Hono();

    app.post("/test", (c) => handleDirectRequest({
      c,
      upstream: first as never,
      upstreamCandidates: [
        { adapter: first as never, entry: { id: "1", provider: "openai", model: "gpt-4o", models: ["gpt-4o"], apiKey: "a", baseUrl: "", label: null, priority: 10, maxRetries: 0, status: "active", addedAt: "", lastUsedAt: null } },
        { adapter: second as never, entry: { id: "2", provider: "openai", model: "gpt-4o", models: ["gpt-4o"], apiKey: "b", baseUrl: "", label: null, priority: 1, maxRetries: 0, status: "active", addedAt: "", lastUsedAt: null } },
      ],
      req,
      fmt,
    } satisfies HandleDirectRequestOptions));

    const res = await app.request("/test", { method: "POST" });
    await res.text();

    const call = fmt.streamTranslator.mock.calls[0] ?? [];
    expect(call[0]).toMatchObject({ api: second });
    expect(first.createResponse).toHaveBeenCalledTimes(1);
    expect(second.createResponse).toHaveBeenCalledTimes(1);
  });

  it("fails over to the next direct upstream when the first stream fails before any chunks are written", async () => {
    const first = {
      tag: "first",
      createResponse: vi.fn(async () => new Response("data: {}\n\n", { status: 200 })),
      parseStream: vi.fn(async function* () {
        throw new Error("stream bootstrap failed");
      }),
    };
    const second = makeUpstream("second", async () => new Response("data: {}\n\n", { status: 200 }));
    const fmt = createMockFormatAdapter({
      streamTranslator: vi.fn(async function* (options) {
        if ((options.api as { tag: string }).tag === "first") {
          throw new Error("stream bootstrap failed");
        }
        options.onUsage({ input_tokens: 10, output_tokens: 20 });
        yield "data: {}\n\n";
      }),
    });
    const req = { ...createDefaultRequest(), isStreaming: true };
    const app = new Hono();

    app.post("/test", (c) => handleDirectRequest({
      c,
      upstream: first as never,
      upstreamCandidates: [
        { adapter: first as never, entry: { id: "1", provider: "openai", model: "gpt-4o", models: ["gpt-4o"], apiKey: "a", baseUrl: "", label: null, priority: 10, maxRetries: 0, status: "active", addedAt: "", lastUsedAt: null } },
        { adapter: second as never, entry: { id: "2", provider: "openai", model: "gpt-4o", models: ["gpt-4o"], apiKey: "b", baseUrl: "", label: null, priority: 1, maxRetries: 0, status: "active", addedAt: "", lastUsedAt: null } },
      ],
      req,
      fmt,
    } satisfies HandleDirectRequestOptions));

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("data: {}");
    expect(first.createResponse).toHaveBeenCalledTimes(1);
    expect(second.createResponse).toHaveBeenCalledTimes(1);
  });

  it("times out pending direct upstream attempts and falls back to the account pool", async () => {
    const upstream = makeUpstream("first", async () => new Response(null, { status: 200 }));
    upstream.createResponse = vi.fn((_request, signal: AbortSignal) =>
      new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
        }, { once: true });
      }),
    );
    const fmt = createMockFormatAdapter();
    const req = createDefaultRequest();
    const fallbackToAccountPool = vi.fn(async () =>
      new Response(JSON.stringify({ fallback: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const app = new Hono();

    app.post("/test", (c) => handleDirectRequest({
      c,
      upstream: upstream as never,
      upstreamCandidates: [
        { adapter: upstream as never, resolvedModel: "gpt-5.5", entry: { id: "1", provider: "openai", model: "gpt-5.5", models: ["gpt-5.5"], apiKey: "a", baseUrl: "", label: null, priority: 10, maxRetries: 0, status: "active", addedAt: "", lastUsedAt: null } },
      ],
      req,
      fmt,
      fallbackToAccountPool,
    } satisfies HandleDirectRequestOptions));

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ fallback: true });
    expect(fallbackToAccountPool).toHaveBeenCalledTimes(1);
    expect(upstream.createResponse).toHaveBeenCalledTimes(1);
  });

  it("falls through when a direct upstream returns a Cloudflare challenge page", async () => {
    const first = makeUpstream("first", async () => {
      throw new CodexApiError(
        403,
        '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>_cf_chl</body></html>',
      );
    });
    const second = makeUpstream("second", async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const fmt = createMockFormatAdapter();
    const req = createDefaultRequest();
    const app = new Hono();

    app.post("/test", (c) => handleDirectRequest({
      c,
      upstream: first as never,
      upstreamCandidates: [
        { adapter: first as never, entry: { id: "1", provider: "openai", model: "gpt-4o", models: ["gpt-4o"], apiKey: "a", baseUrl: "", label: null, priority: 10, maxRetries: 0, status: "active", addedAt: "", lastUsedAt: null } },
        { adapter: second as never, entry: { id: "2", provider: "openai", model: "gpt-4o", models: ["gpt-4o"], apiKey: "b", baseUrl: "", label: null, priority: 1, maxRetries: 0, status: "active", addedAt: "", lastUsedAt: null } },
      ],
      req,
      fmt,
    } satisfies HandleDirectRequestOptions));

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(200);
    expect(first.createResponse).toHaveBeenCalledTimes(1);
    expect(second.createResponse).toHaveBeenCalledTimes(1);
  });
});
