/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/preact";
import { I18nProvider } from "../../../../shared/i18n/context";

const mockLogs = vi.hoisted(() => ({
  useLogs: vi.fn(),
}));

const mockSettings = vi.hoisted(() => ({
  useSettings: vi.fn(() => ({ apiKey: null })),
}));

const mockGeneralSettings = vi.hoisted(() => ({
  useGeneralSettings: vi.fn(),
}));

vi.mock("../../../../shared/hooks/use-logs", () => ({
  useLogs: mockLogs.useLogs,
}));

vi.mock("../../../../shared/hooks/use-settings", () => ({
  useSettings: mockSettings.useSettings,
}));

vi.mock("../../../../shared/hooks/use-general-settings", () => ({
  useGeneralSettings: mockGeneralSettings.useGeneralSettings,
}));

import { LogsPage } from "../LogsPage";

function makeGeneralSettings(overrides: Record<string, unknown> = {}) {
  return {
    data: { logs_llm_only: true },
    saving: false,
    save: vi.fn(),
    ...overrides,
  };
}

function makeLogsState(overrides: Partial<ReturnType<typeof mockLogs.useLogs>> = {}) {
  return {
    records: [
      {
        id: "1",
        requestId: "r1",
        direction: "ingress",
        ts: "2026-04-15T00:00:01.000Z",
        method: "POST",
        path: "/v1/messages",
        status: 200,
        latencyMs: 10,
      },
    ],
    total: 1,
    loading: false,
    state: { enabled: true, paused: false },
    setLogState: vi.fn(),
    selected: null,
    selectLog: vi.fn(),
    direction: "egress",
    setDirection: vi.fn(),
    search: "",
    setSearch: vi.fn(),
    page: 0,
    pageSize: 50,
    prevPage: vi.fn(),
    nextPage: vi.fn(),
    hasPrev: false,
    hasNext: true,
    ...overrides,
  };
}

function renderLogsPage() {
  return render(
    <I18nProvider>
      <LogsPage embedded />
    </I18nProvider>,
  );
}

function hasAncestorClass(element: Element, className: string): boolean {
  let current: Element | null = element;
  while (current) {
    if (current.classList.contains(className)) return true;
    current = current.parentElement;
  }
  return false;
}

afterEach(() => {
  cleanup();
});

describe("LogsPage", () => {
  it("renders pagination controls and invokes page handlers", () => {
    const nextPage = vi.fn();
    mockLogs.useLogs.mockReturnValue(makeLogsState({ nextPage, hasNext: true }));
    mockGeneralSettings.useGeneralSettings.mockReturnValue(makeGeneralSettings());

    renderLogsPage();

    expect(screen.getByText("1 logs")).toBeTruthy();
    expect(screen.getByText("1 total · 1-1")).toBeTruthy();
    fireEvent.click(screen.getByText("Next"));
    expect(nextPage).toHaveBeenCalledTimes(1);
  });

  it("renders zero latency as seconds", () => {
    mockLogs.useLogs.mockReturnValue(
      makeLogsState({
        records: [
          {
            id: "1",
            requestId: "r1",
            direction: "ingress",
            ts: "2026-04-15T00:00:01.000Z",
            method: "GET",
            path: "/v1/models",
            status: 200,
            latencyMs: 0,
          },
        ],
      }),
    );
    mockGeneralSettings.useGeneralSettings.mockReturnValue(makeGeneralSettings());

    renderLogsPage();

    expect(screen.getByText("0.00 s")).toBeTruthy();
  });

  it("renders compute tokens with unit", () => {
    mockLogs.useLogs.mockReturnValue(
      makeLogsState({
        records: [
          {
            id: "1",
            requestId: "r1",
            direction: "egress",
            ts: "2026-04-15T00:00:01.000Z",
            method: "POST",
            path: "/v1/responses",
            model: "gpt-5.4",
            upstreamName: "codex",
            inputTokens: 1200,
            outputTokens: 300,
            cachedTokens: 700,
            status: 200,
            latencyMs: 1250,
          },
        ],
      }),
    );
    mockGeneralSettings.useGeneralSettings.mockReturnValue(makeGeneralSettings());

    renderLogsPage();

    expect(screen.getByText("1.20K tok / 0.30K tok")).toBeTruthy();
    expect(screen.getByText("0.80K tok")).toBeTruthy();
    expect(screen.getByText("0.70K tok")).toBeTruthy();
  });

  it("aggregates retry attempts for the same egress upstream", () => {
    mockLogs.useLogs.mockReturnValue(
      makeLogsState({
        records: [
          {
            id: "2",
            requestId: "r-retry",
            direction: "egress",
            ts: "2026-04-15T00:00:02.000Z",
            method: "POST",
            path: "/v1/responses",
            model: "gpt-5.4",
            provider: "codex",
            status: 200,
            latencyMs: 250,
            inputTokens: 100,
            outputTokens: 50,
            cachedTokens: 40,
          },
          {
            id: "1",
            requestId: "r-retry",
            direction: "egress",
            ts: "2026-04-15T00:00:01.000Z",
            method: "POST",
            path: "/v1/responses",
            model: "gpt-5.4",
            provider: "codex",
            status: 502,
            latencyMs: 1000,
            error: "empty response",
          },
        ],
        total: 2,
      }),
    );
    mockGeneralSettings.useGeneralSettings.mockReturnValue(makeGeneralSettings());

    renderLogsPage();

    const retryCount = screen.getByText("+1");
    expect(screen.getByText("codex")).toBeTruthy();
    expect(retryCount.classList.contains("text-red-600")).toBe(true);
    expect(screen.getByText("1.25 s")).toBeTruthy();
    expect(screen.getByText("0.11K tok")).toBeTruthy();
    expect(screen.getByText("0.04K tok")).toBeTruthy();
    expect(screen.queryByText("1.00 s")).toBeNull();
  });

  it("keeps different upstreams for the same request as separate rows", () => {
    mockLogs.useLogs.mockReturnValue(
      makeLogsState({
        records: [
          {
            id: "2",
            requestId: "r-fallback",
            direction: "egress",
            ts: "2026-04-15T00:00:02.000Z",
            method: "POST",
            path: "/v1/responses",
            model: "gpt-5.4",
            provider: "codex",
            status: 200,
            latencyMs: 250,
          },
          {
            id: "1",
            requestId: "r-fallback",
            direction: "egress",
            ts: "2026-04-15T00:00:01.000Z",
            method: "POST",
            path: "/v1/responses",
            model: "gpt-5.4",
            provider: "openai",
            status: 502,
            latencyMs: 1000,
            error: "bad gateway",
          },
        ],
        total: 2,
      }),
    );
    mockGeneralSettings.useGeneralSettings.mockReturnValue(makeGeneralSettings());

    renderLogsPage();

    expect(screen.getByText("codex")).toBeTruthy();
    expect(screen.getByText("openai")).toBeTruthy();
    expect(screen.queryByText("+1")).toBeNull();
  });

  it("uses request model instead of the generic custom provider label", () => {
    mockLogs.useLogs.mockReturnValue(
      makeLogsState({
        records: [
          {
            id: "1",
            requestId: "r-custom",
            direction: "egress",
            ts: "2026-04-15T00:00:01.000Z",
            method: "POST",
            path: "/v1/responses",
            model: "qwen3-coder",
            provider: "custom",
            request: { model: "qwen/qwen3-coder" },
            status: 200,
            latencyMs: 100,
          },
        ],
      }),
    );
    mockGeneralSettings.useGeneralSettings.mockReturnValue(makeGeneralSettings());

    renderLogsPage();

    expect(screen.getByText("qwen/qwen3-coder")).toBeTruthy();
    expect(screen.queryByText("custom")).toBeNull();
  });

  it("renders and toggles the logs mode button", () => {
    const save = vi.fn();
    mockLogs.useLogs.mockReturnValue(makeLogsState());
    mockGeneralSettings.useGeneralSettings.mockReturnValue(makeGeneralSettings({ save }));

    renderLogsPage();

    fireEvent.click(screen.getByText("Only record LLM logs (click to toggle)"));
    expect(save).toHaveBeenCalledWith({ logs_llm_only: false });
  });

  it("keeps the log list constrained on narrow screens", () => {
    mockLogs.useLogs.mockReturnValue(makeLogsState());
    mockGeneralSettings.useGeneralSettings.mockReturnValue(makeGeneralSettings());

    renderLogsPage();

    const timeHeader = screen.getByText("Time");
    expect(hasAncestorClass(timeHeader, "overflow-x-auto")).toBe(true);
    expect(hasAncestorClass(timeHeader, "min-w-[820px]")).toBe(true);
  });
});
