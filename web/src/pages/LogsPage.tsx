import { useMemo } from "preact/hooks";
import { useT } from "../../../shared/i18n/context";
import { useLogs } from "../../../shared/hooks/use-logs";
import { useSettings } from "../../../shared/hooks/use-settings";
import { useGeneralSettings } from "../../../shared/hooks/use-general-settings";

export function LogsPage({ embedded = false }: { embedded?: boolean }) {
  const t = useT();
  const logs = useLogs();
  const settings = useSettings();
  const gs = useGeneralSettings(settings.apiKey);
  const logsLlmOnly = gs.data?.logs_llm_only ?? true;

  const formatTokenValue = (value: number | null): string => {
    if (value == null) return "-";
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M tok`;
    if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K tok`;
    return `${value} tok`;
  };

  const formatLatencySeconds = (value: number | null | undefined): string => {
    if (value == null) return "-";
    return `${(value / 1000).toFixed(2)} s`;
  };

  const toggleLogsMode = async () => {
    await gs.save({ logs_llm_only: !logsLlmOnly });
  };

  const list = useMemo(() => {
    return logs.records.map((r) => ({
      ...r,
      time: new Date(r.ts).toLocaleTimeString(),
      computeTokens:
        r.direction === "egress" &&
        typeof r.inputTokens === "number" &&
        typeof r.outputTokens === "number"
          ? r.inputTokens + r.outputTokens
          : null,
    }));
  }, [logs.records]);

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
            <div class="min-w-[760px]">
              <div class="grid grid-cols-[72px_76px_1.6fr_1.3fr_1.3fr_96px_96px_88px_84px_96px] text-xs text-slate-500 px-3 py-2 border-b border-slate-200 dark:border-border-dark gap-2">
                <div class="col-span-1">{t("logsTime")}</div>
                <div class="col-span-1">{t("logsDirection")}</div>
                <div>{t("logsPath")}</div>
                <div>{t("logsModel")}</div>
                <div>{t("logsProvider")}</div>
                <div class="col-span-1">{t("logsInputTokens")}</div>
                <div class="col-span-1">{t("logsOutputTokens")}</div>
                <div class="col-span-1">{t("logsCompute")}</div>
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
                    class="grid grid-cols-[72px_76px_1.6fr_1.3fr_1.3fr_96px_96px_88px_84px_96px] px-3 py-2 text-xs border-b border-slate-100 dark:border-border-dark gap-2"
                  >
                    <div class="col-span-1 text-slate-500">{row.time}</div>
                    <div class="col-span-1">
                      <span class={`px-1.5 py-0.5 rounded ${row.direction === "ingress" ? "bg-success-container text-success" : "bg-info-container text-info"}`}>
                        {t(`logsFilter.${row.direction}`)}
                      </span>
                    </div>
                    <div class="truncate">{row.path}</div>
                    <div class="truncate">{row.model ?? "-"}</div>
                    <div class="truncate">{row.upstreamName ?? row.provider ?? "-"}</div>
                    <div class="col-span-1">{row.inputTokens != null ? row.inputTokens : "-"}</div>
                    <div class="col-span-1">{row.outputTokens != null ? row.outputTokens : "-"}</div>
                    <div class="col-span-1">{formatTokenValue(row.computeTokens)}</div>
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
