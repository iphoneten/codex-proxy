import { useState, useEffect, useRef } from "preact/hooks";
import { I18nProvider } from "../../shared/i18n/context";
import { ThemeProvider } from "../../shared/theme/context";
import { Header } from "./components/Header";
import { UpdateModal } from "./components/UpdateModal";
import { AddAccount } from "./components/AddAccount";
import { AccountList } from "./components/AccountList";
import { SettingsTab } from "./components/SettingsTab";
import { ProxyPool } from "./components/ProxyPool";
import { Footer } from "./components/Footer";
import { ApiKeyManager } from "./components/ApiKeyManager";
import { ProxySettings } from "./pages/ProxySettings";
import { AccountManagement } from "./pages/AccountManagement";
import { UsageStats } from "./pages/UsageStats";
import { LogsPage } from "./pages/LogsPage";
import { ErrorsPage } from "./pages/ErrorsPage";
import { useAccounts } from "../../shared/hooks/use-accounts";
import { useErrorLogsCount } from "../../shared/hooks/use-error-logs";
import { useProxies } from "../../shared/hooks/use-proxies";
import { useStatus } from "../../shared/hooks/use-status";
import { useUpdateStatus } from "../../shared/hooks/use-update-status";
import { useI18n, useT } from "../../shared/i18n/context";
import type { TranslationKey } from "../../shared/i18n/translations";
import { getShowUpdateDialogPreference, shouldAutoOpenUpdateModal } from "./update-modal-policy";

export { shouldAutoOpenUpdateModal };

function useUpdateMessage() {
  const { t } = useI18n();
  const update = useUpdateStatus();

  let msg: string | null = null;
  let color = "text-primary";

  if (!update.checking && update.result) {
    const parts: string[] = [];
    const r = update.result;
    if (r.proxy?.error) { parts.push(`Proxy: ${r.proxy.error}`); color = "text-red-500"; }
    else if (r.proxy?.update_available) { parts.push(t("updateAvailable")); color = "text-amber-500"; }
    if (r.codex?.error) { parts.push(`Codex: ${r.codex.error}`); color = "text-red-500"; }
    else if (r.codex_update_in_progress) { parts.push(t("fingerprintUpdating")); }
    else if (r.codex?.version_changed) { parts.push(`Codex: v${r.codex.current_version}`); color = "text-blue-500"; }
    msg = parts.length > 0 ? parts.join(" · ") : t("upToDate");
  } else if (!update.checking && update.error) { msg = update.error; color = "text-red-500"; }

  const hasUpdate = update.status?.proxy.update_available ?? false;
  const showUpdateDialog = getShowUpdateDialogPreference(update.status);
  const proxyUpdateInfo = hasUpdate
    ? { mode: update.status!.proxy.mode, commits: update.status!.proxy.commits, changelog: update.status!.proxy.changelog ?? null, release: update.status!.proxy.release }
    : null;

  return { ...update, msg, color, hasUpdate, showUpdateDialog, proxyUpdateInfo };
}

// ── Tab definitions ─────────────────────────────────────────────────

const TABS: Array<{ hash: string; label: TranslationKey }> = [
  { hash: "", label: "overview" },
  { hash: "#/accounts", label: "manageAccounts" },
  { hash: "#/api-keys", label: "apiKeys" },
  { hash: "#/proxies", label: "proxySettings" },
  { hash: "#/usage-stats", label: "usageStats" },
  { hash: "#/logs", label: "logs" },
  { hash: "#/errors", label: "errorsTab" },
  { hash: "#/settings", label: "settings" },
];

export function TabBar({ activeHash }: { activeHash: string }) {
  const t = useT();
  return (
    <div class="flex flex-wrap items-center gap-1.5 mb-4 max-w-full">
      {TABS.map((tab) => {
        const isActive = activeHash === tab.hash;
        return (
          <a
            key={tab.hash}
            href={tab.hash || "#/"}
            class={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              isActive
                ? "bg-primary-container text-primary"
                : "text-slate-500 dark:text-text-dim hover:bg-slate-100 dark:hover:bg-border-dark"
            }`}
          >
            {t(tab.label)}
          </a>
        );
      })}
    </div>
  );
}

// ── Dashboard ───────────────────────────────────────────────────────

function Dashboard() {
  const accounts = useAccounts();
  const proxies = useProxies();
  const status = useStatus(accounts.list.length);
  const update = useUpdateMessage();
  const [showModal, setShowModal] = useState(false);
  const prevUpdateAvailable = useRef(false);
  const hash = useHash();
  const errorCount = useErrorLogsCount();

  useEffect(() => {
    if (shouldAutoOpenUpdateModal({
      hasUpdate: update.hasUpdate,
      previousHasUpdate: prevUpdateAvailable.current,
      mode: update.proxyUpdateInfo?.mode ?? null,
      showUpdateDialog: update.showUpdateDialog,
    })) {
      setShowModal(true);
    }
    prevUpdateAvailable.current = update.hasUpdate;
  }, [update.hasUpdate, update.proxyUpdateInfo?.mode, update.showUpdateDialog]);

  const handleProxyChange = async (accountId: string, proxyId: string) => {
    accounts.patchLocal(accountId, { proxyId });
    await proxies.assignProxy(accountId, proxyId);
  };

  // Redirect legacy routes
  if (hash === "#/account-management") { location.hash = "#/accounts"; return null; }
  if (hash === "#/proxy-settings") { location.hash = "#/proxies"; return null; }

  const activeTab = TABS.find((t) => t.hash === hash)?.hash ?? "";

  return (
    <div class="min-h-screen flex flex-col bg-slate-50 dark:bg-bg-dark">
      <Header
        onAddAccount={accounts.startAdd}
        onCheckUpdate={update.checkForUpdate}
        onOpenUpdateModal={() => setShowModal(true)}
        checking={update.checking}
        updateStatusMsg={update.msg}
        updateStatusColor={update.color}
        version={update.status?.proxy.version ?? null}
        commit={update.status?.proxy.commit ?? null}
        hasUpdate={update.hasUpdate}
        unreadErrors={errorCount.unread}
      />

      <main class="flex-grow px-4 md:px-8 lg:px-40 py-8 flex justify-center">
        <div class="flex flex-col w-full max-w-[960px]">
          <AddAccount
            visible={accounts.addVisible}
            onCancel={accounts.cancelAdd}
            onSubmitRelay={accounts.submitRelay}
            onAddByRefreshToken={accounts.addByRefreshToken}
            addInfo={accounts.addInfo}
            addError={accounts.addError}
          />

          <TabBar activeHash={activeTab} />

          {activeTab === "" && (
            <div class="flex flex-col gap-6">
              <AccountList
                accounts={accounts.list}
                loading={accounts.loading}
                onDelete={accounts.deleteAccount}
                onRefresh={accounts.refresh}
                refreshing={accounts.refreshing}
                lastUpdated={accounts.lastUpdated}
                proxies={proxies.proxies}
                onProxyChange={handleProxyChange}
                onExport={accounts.exportAccounts}
                onImport={accounts.importAccounts}
                onToggleStatus={accounts.toggleStatus}
                onUpdateLabel={accounts.updateLabel}
              />
              <ProxyPool proxies={proxies} />
            </div>
          )}

          {activeTab === "#/accounts" && (
            <AccountManagement embedded />
          )}

          {activeTab === "#/api-keys" && (
            <ApiKeyManager />
          )}

          {activeTab === "#/proxies" && (
            <div class="flex flex-col gap-6">
              <ProxyPool proxies={proxies} />
              <ProxySettings embedded />
            </div>
          )}

          {activeTab === "#/usage-stats" && (
            <UsageStats embedded />
          )}

          {activeTab === "#/logs" && (
            <LogsPage embedded />
          )}

          {activeTab === "#/errors" && (
            <ErrorsPage />
          )}

          {activeTab === "#/settings" && (
            <SettingsTab
              baseUrl={status.baseUrl}
              apiKey={status.apiKey}
              models={status.models}
              selectedModel={status.selectedModel}
              onModelChange={status.setSelectedModel}
              modelFamilies={status.modelFamilies}
              selectedEffort={status.selectedEffort}
              onEffortChange={status.setSelectedEffort}
              selectedSpeed={status.selectedSpeed}
              onSpeedChange={status.setSelectedSpeed}
            />
          )}
        </div>
      </main>

      <Footer updateStatus={update.status} />
      {update.proxyUpdateInfo && (
        <UpdateModal
          open={showModal}
          onClose={() => setShowModal(false)}
          mode={update.proxyUpdateInfo.mode}
          commits={update.proxyUpdateInfo.commits}
          changelog={update.proxyUpdateInfo.changelog}
          release={update.proxyUpdateInfo.release}
          onApply={update.applyUpdate}
          applying={update.applying}
          restarting={update.restarting}
          restartFailed={update.restartFailed}
          updateSteps={update.updateSteps}
        />
      )}
    </div>
  );
}

// ── Utilities ────────────────────────────────────────────────────────

function useHash(): string {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const handler = () => setHash(location.hash);
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);
  return hash;
}

export function App() {
  return (
    <I18nProvider>
      <ThemeProvider>
        <Dashboard />
      </ThemeProvider>
    </I18nProvider>
  );
}
