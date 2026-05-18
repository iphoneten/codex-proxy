/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";

const mockApiKeys = vi.hoisted(() => ({
  useApiKeys: vi.fn(),
}));

const mockUsage = vi.hoisted(() => ({
  useUsageSummary: vi.fn(),
}));

vi.mock("../../../../shared/hooks/use-api-keys", () => ({
  useApiKeys: mockApiKeys.useApiKeys,
}));

vi.mock("../../../../shared/hooks/use-usage-stats", () => ({
  useUsageSummary: mockUsage.useUsageSummary,
}));

vi.mock("../../../../shared/i18n/context", () => ({
  useT: vi.fn(() => (key: string) => key),
}));

import { ApiKeyManager } from "../../../../web/src/components/ApiKeyManager";

describe("ApiKeyManager", () => {
  beforeEach(() => {
    mockApiKeys.useApiKeys.mockReturnValue({
      keys: [
        {
          id: "1",
          provider: "custom",
          models: ["codex-a"],
          apiKey: "",
          apiKeyMasked: "sk***a",
          baseUrl: "https://example.com/v1",
          label: "主线路",
          priority: 0,
          maxRetries: 2,
          status: "active",
          addedAt: "2026-05-16T00:00:00.000Z",
          lastUsedAt: null,
        },
      ],
      catalog: {},
      loading: false,
      addKey: vi.fn(),
      deleteKey: vi.fn(),
      toggleStatus: vi.fn(),
      updateBaseUrl: vi.fn(),
      revealApiKey: vi.fn(),
      refreshEntryModels: vi.fn(),
      addEntryModels: vi.fn(),
      removeEntryModels: vi.fn(),
      updateRouting: vi.fn(),
      reorderKeys: vi.fn(),
      importKeys: vi.fn(),
      exportKeys: vi.fn(),
      fetchCustomModels: vi.fn(),
      refresh: vi.fn(),
    });
    mockUsage.useUsageSummary.mockReturnValue({
      summary: {
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_cached_tokens: 0,
        total_image_input_tokens: 0,
        total_image_output_tokens: 0,
        total_image_request_count: 0,
        total_image_request_failed_count: 0,
        total_request_count: 0,
        total_accounts: 0,
        active_accounts: 0,
        upstream_breakdown: [
          {
            key: "api-key:1",
            provider: "custom",
            label: "主线路",
            input_tokens: 1200,
            output_tokens: 340,
            cached_tokens: 200,
            image_input_tokens: 0,
            image_output_tokens: 0,
            request_count: 5,
            updated_at: "2026-05-16T12:00:00.000Z",
          },
        ],
      },
      loading: false,
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("moves usage stats into upstream management", async () => {
    render(<ApiKeyManager />);

    expect(screen.queryByText("upstreamBreakdown")).toBeNull();
    expect(screen.getByText("查看用量")).toBeTruthy();

    await screen.getByText("查看用量").click();

    expect(screen.getByText("上游用量")).toBeTruthy();
    expect(screen.getByText("1.2K")).toBeTruthy();
    expect(screen.getByText("340")).toBeTruthy();
    expect(screen.getByText("200")).toBeTruthy();
    expect(screen.getByText("5")).toBeTruthy();
  });
  it("reorders upstream rows with drag and drop", async () => {
    const reorderKeys = vi.fn(async () => undefined);
    mockApiKeys.useApiKeys.mockReturnValue({
      ...mockApiKeys.useApiKeys(),
      keys: [
        {
          id: "1",
          provider: "custom",
          models: ["codex-a"],
          apiKey: "",
          apiKeyMasked: "sk***a",
          baseUrl: "https://a.example.com/v1",
          label: "线路 A",
          priority: 2,
          maxRetries: 2,
          status: "active",
          addedAt: "2026-05-16T00:00:00.000Z",
          lastUsedAt: null,
        },
        {
          id: "2",
          provider: "custom",
          models: ["codex-b"],
          apiKey: "",
          apiKeyMasked: "sk***b",
          baseUrl: "https://b.example.com/v1",
          label: "线路 B",
          priority: 1,
          maxRetries: 2,
          status: "active",
          addedAt: "2026-05-16T00:00:01.000Z",
          lastUsedAt: null,
        },
      ],
      reorderKeys,
    });

    render(<ApiKeyManager />);

    const firstRow = screen.getByText("线路 A").closest("div[draggable]")!;
    const secondRow = screen.getByText("线路 B").closest("div[draggable]")!;
    fireEvent.dragStart(firstRow);
    fireEvent.dragOver(secondRow);
    fireEvent.drop(secondRow);

    expect(reorderKeys).toHaveBeenCalledWith(["2", "1"]);
  });

});
