import { useMemo } from "preact/hooks";
import { useT } from "../../../shared/i18n/context";
import { useLogs, type LogRecord } from "../../../shared/hooks/use-logs";
import { useSettings } from "../../../shared/hooks/use-settings";
import { useGeneralSettings } from "../../../shared/hooks/use-general-settings";

type DisplayLogRecord = LogRecord & {
  time: string;
  tokenPair: string;
  computeTokens: number | null;
  cacheTokens: number | null;
  attemptCount: number;
};

function getLoggedRequestModel(record: LogRecord): string | null {
  const request = record.request;
  if (!request || typeof request !== "object") return null;
  const model = (request as { model?: unknown }).model;
  return typeof model === "string" && model.trim() ? model.trim() : null;
}

function getUpstreamLabel(record: LogRecord): string {
  const upstreamName = record.upstreamName?.trim();
  if (upstreamName) return upstreamName;
  if (record.provider === "custom") {
    return getLoggedRequestModel(record) ?? record.model ?? "Custom upstream";
  }
  return record.provider ?? "-";
}

function getAggregationKey(record: LogRecord): string {
  const upstreamKey = getUpstreamLabel(record);
  if (record.direction === "egress" && record.requestId && record.requestId !== "-" && upstreamKey !== "-") {
    return `${record.direction}:${record.requestId}:${upstreamKey}`;
  }
  return `${record.direction}:${record.id}`;
}

function addLatency(left: number | null | undefined, right: number | null | undefined): number | null {
  if (left == null) return right ?? null;
  if (right == null) return left;
  return left + right;
}

function getCacheTokens(record: LogRecord): number | null {
  if (record.direction !== "egress") return null;
  return typeof record.cachedTokens === "number" ? record.cachedTokens : 0;
}

function getComputeTokens(record: LogRecord): number | null {
  if (
    record.direction === "egress" &&
    typeof record.inputTokens === "number" &&
    typeof record.outputTokens === "number"
  ) {
    const cachedTokens = getCacheTokens(record) ?? 0;
    return Math.max(0, record.inputTokens - cachedTokens) + record.outputTokens;
  }
  return null;
}

function formatTokenValue(value: number | null | undefined): string {
  if (value == null) return "-";
  return `${(value / 1_000).toFixed(2)}K tok`;
}

function getTokenPair(record: LogRecord): string {
  if (record.direction !== "egress") return "-";
  return `${formatTokenValue(record.inputTokens)} / ${formatTokenValue(record.outputTokens)}`;
}

export function buildDisplayLogRows(records: LogRecord[]): DisplayLogRecord[] {
  const rows: DisplayLogRecord[] = [];
  const byKey = new Map<string, DisplayLogRecord>();

  for (const record of records) {
    const key = getAggregationKey(record);
    const existing = byKey.get(key);
    if (!existing) {
      const row: DisplayLogRecord = {
        ...record,
        time: new Date(record.ts).toLocaleTimeString(),
        tokenPair: getTokenPair(record),
        computeTokens: getComputeTokens(record),
        cacheTokens: getCacheTokens(record),
        attemptCount: 1,
      };
      byKey.set(key, row);
      rows.push(row);
      continue;
    }

    existing.latencyMs = addLatency(existing.latencyMs, record.latencyMs);
    existing.attemptCount += 1;
  }

  return rows;
}

export function LogsPage({ embedded = false }: { embedded?: boolean }) {
  const t = useT();
  const logs = useLogs();
  const settings = useSettings();
  const gs = useGeneralSettings(settings.apiKey);
  const logsLlmOnly = gs.data?.logs_llm_only ?? true;

  const formatLatencySeconds = (value: number | null | undefined): string => {
    if (value == null) return "-";
    return `${(value / 1000).toFixed(2)} s`;
  };

  const toggleLogsMode = async () => {
    await gs.save({ logs_llm_only: !logsLlmOnly });
  };

  const list = useMemo(() => buildDisplayLogRows(logs.records), [logs.records]);

  const pageStart = logs.total === 0 ? 0 : logs.page * logs.pageSize + 1;
  const pageEnd = logs.total === 0 ? 0 : Math.min(logs.total, (logs.page + 1) * logs.pageSize);
  const pageInfo = `${pageStart}-${pageEnd}`;

  return (
    <div class={`flex flex-col gap-4 ${embedded ? "" : "p-6"}`}>
      <div class="flex items-center gap-3 flex-wrap">
        <button
          class={`px-3 py-1.5 rounded-lg text-xs font-medium ${logs.state?.enabled ? "bg-primary-container text-primary" : "bg-slate-200 text-slate-600"}`}
          onClick={() => logs.setLogState({ enabled: !logs.state?.enabled })}
        >
          {logs.state?.enabled ? t("logsEnabled") : t("logsDisabled")}
        </button>
        <button
          class={`px-3 py-1.5 rounded-lg text-xs font-medium ${
            !logs.state?.enabled
              ? "bg-slate-100 text-slate-400 cursor-not-allowed"
              : logs.state?.paused
                ? "bg-warning-container text-warning"
                : "bg-slate-200 text-slate-600"
          }`}
          onClick={() => logs.state?.enabled && logs.setLogState({ paused: !logs.state?.paused })}
          disabled={!logs.state?.enabled}
        >
          {logs.state?.paused ? t("logsPaused") : t("logsRunning")}
        </button>

        <button
          class="px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-200 text-slate-700 hover:bg-slate-300"
          onClick={toggleLogsMode}
          disabled={gs.saving}
        >
          {logsLlmOnly ? t("logsModeLlmOnlyToggle") : t("logsModeAllToggle")}
        </button>

        <input
          class="px-2.5 py-1 rounded-md text-xs bg-white dark:bg-bg-dark border border-slate-200 dark:border-border-dark"
          value={logs.search}
          onInput={(e) => logs.setSearch((e.target as HTMLInputElement).value)}
          placeholder={t("logsSearch")}
        />

        <div class="text-xs text-slate-500">
          {t("logsCount", { count: logs.total })}
        </div>
      </div>

      <div class="min-w-0">
        <div class="border border-slate-200 dark:border-border-dark rounded-lg overflow-hidden bg-white dark:bg-bg-dark">
          <div class="overflow-x-auto">
            <div class="min-w-[820px]">
              <div class="grid grid-cols-[72px_1.6fr_1.3fr_1.3fr_120px_88px_88px_84px_96px] text-xs text-slate-500 px-3 py-2 border-b border-slate-200 dark:border-border-dark gap-2">
                <div class="col-span-1">{t("logsTime")}</div>
                <div>{t("logsPath")}</div>
                <div>{t("logsModel")}</div>
                <div>{t("logsProvider")}</div>
                <div class="col-span-1">{t("logsTokens")}</div>
                <div class="col-span-1">{t("logsCompute")}</div>
                <div class="col-span-1">{t("logsCachedTokens")}</div>
                <div class="col-span-1">{t("logsStatus")}</div>
                <div class="col-span-1">{t("logsLatency")}</div>
              </div>
              {logs.loading && (
                <div class="p-4 text-xs text-slate-500">{t("logsLoading")}</div>
              )}
              {!logs.loading && list.length === 0 && (
                <div class="p-4 text-xs text-slate-500">{t("logsEmpty")}</div>
              )}
              <div class="max-h-[420px] overflow-y-auto">
                {list.map((row) => (
                  <div
                    key={row.id}
                    class="grid grid-cols-[72px_1.6fr_1.3fr_1.3fr_120px_88px_88px_84px_96px] px-3 py-2 text-xs border-b border-slate-100 dark:border-border-dark gap-2"
                  >
                    <div class="col-span-1 text-slate-500">{row.time}</div>
                    <div class="truncate">{row.path}</div>
                    <div class="truncate">{row.model ?? "-"}</div>
                    <div class="truncate" title={row.requestId}>
                      <span>{getUpstreamLabel(row)}</span>
                      {row.attemptCount > 1 ? (
                        <span class="ml-1 font-semibold text-red-600 dark:text-red-400">
                          +{row.attemptCount - 1}
                        </span>
                      ) : null}
                    </div>
                    <div class="col-span-1">{row.tokenPair}</div>
                    <div class="col-span-1">{formatTokenValue(row.computeTokens)}</div>
                    <div class="col-span-1">{formatTokenValue(row.cacheTokens)}</div>
                    <div class="col-span-1">{row.status ?? "-"}</div>
                    <div class="col-span-1">{formatLatencySeconds(row.latencyMs)}</div>
                  </div>
                ))}
              </div>
              <div class="flex items-center justify-between px-3 py-2 border-t border-slate-200 dark:border-border-dark text-xs text-slate-500">
                <button
                  class="px-2 py-1 rounded bg-slate-100 dark:bg-border-dark disabled:opacity-50"
                  disabled={!logs.hasPrev}
                  onClick={logs.prevPage}
                >
                  {t("logsPrev")}
                </button>
                <span>{t("logsPageSummary", { total: logs.total, range: pageInfo })}</span>
                <button
                  class="px-2 py-1 rounded bg-slate-100 dark:bg-border-dark disabled:opacity-50"
                  disabled={!logs.hasNext}
                  onClick={logs.nextPage}
                >
                  {t("logsNext")}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
