import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("initTransport", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(async () => {
    const mod = await import("@src/tls/transport.js");
    mod.resetTransport();
    vi.restoreAllMocks();
  });

  it("uses native transport when the addon loads", async () => {
    vi.doMock("@src/tls/native-transport.js", () => ({
      isNativeAvailable: () => true,
      createNativeTransport: vi.fn(async () => ({
        isImpersonate: () => false,
      })),
    }));
    vi.doMock("@src/tls/node-transport.js", () => ({
      createNodeTransport: vi.fn(async () => {
        throw new Error("node fallback should not be used");
      }),
    }));

    const mod = await import("@src/tls/transport.js");
    const transport = await mod.initTransport();
    const info = mod.getTransportInfo();

    expect(transport.isImpersonate()).toBe(false);
    expect(info.type).toBe("native");
    expect(info.initialized).toBe(true);
  });

  it("falls back to node transport when native load fails", async () => {
    vi.doMock("@src/tls/native-transport.js", () => ({
      isNativeAvailable: () => true,
      createNativeTransport: vi.fn(async () => {
        throw new Error("bad native binary");
      }),
    }));
    vi.doMock("@src/tls/node-transport.js", () => ({
      createNodeTransport: vi.fn(async () => ({
        isImpersonate: () => false,
      })),
    }));

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const mod = await import("@src/tls/transport.js");
    await mod.initTransport();
    const info = mod.getTransportInfo();

    expect(info.type).toBe("node");
    expect(info.initialized).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Native transport unavailable, falling back to undici"),
    );
  });
});
