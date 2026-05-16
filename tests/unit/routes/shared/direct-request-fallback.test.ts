import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { handleDirectRequest } from "@src/routes/shared/direct-request-handler.js";
import { CodexApiError } from "@src/proxy/codex-api.js";
import type { HandleDirectRequestOptions, ProxyRequest } from "@src/routes/shared/proxy-handler-types.js";
import { createMockFormatAdapter } from "@helpers/format-adapter.js";

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
        { adapter: first as never, entry: { id: "1", provider: "openai", model: "gpt-4o", apiKey: "a", baseUrl: "", label: null, priority: 10, maxRetries: 1, status: "active", addedAt: "", lastUsedAt: null } },
        { adapter: second as never, entry: { id: "2", provider: "openai", model: "gpt-4o", apiKey: "b", baseUrl: "", label: null, priority: 1, maxRetries: 0, status: "active", addedAt: "", lastUsedAt: null } },
      ],
      req,
      fmt,
    } satisfies HandleDirectRequestOptions));

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(200);
    expect(first.createResponse).toHaveBeenCalledTimes(2);
    expect(second.createResponse).toHaveBeenCalledTimes(1);
  });
});
