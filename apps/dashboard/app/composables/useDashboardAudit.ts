import type { DashboardAuditInfo, DashboardMeData } from "../../lib/dashboard-api-types";
import { getProviderFromSlug } from "../../lib/provider-accounts";
import { dashboardDataKeys } from "./useDashboardDataInvalidation";

const auditShellRefreshDataKeys = [
  "dashboard-me",
  dashboardDataKeys.shellAccounts,
  dashboardDataKeys.shellModelFamilyCounts,
  dashboardDataKeys.modelSearch,
];

const emptyAuditInfo: DashboardAuditInfo = {
  active: false,
  readonly: false,
  user: null,
};

export function useDashboardAudit() {
  const route = useRoute();
  const dashboardMe = useState<DashboardMeData | null>("dashboard-me-state", () => null);
  const auditRefreshVersion = useState("dashboard-audit-refresh-version", () => 0);

  const audit = computed(() => dashboardMe.value?.audit ?? emptyAuditInfo);
  const isAuditMode = computed(() => audit.value.active && Boolean(audit.value.user));
  const auditUser = computed(() => audit.value.user);

  function getCurrentPageRefreshKeys(): string[] {
    if (route.path === "/dashboard") return [dashboardDataKeys.accountsOverview];
    if (route.path === "/dashboard/models") return [dashboardDataKeys.models];
    if (route.path === "/dashboard/api-keys") return [dashboardDataKeys.apiKeys];
    if (route.path === "/dashboard/playground") return [dashboardDataKeys.playgroundOptions];

    const provider = getProviderFromSlug(String(route.params.provider ?? ""));
    return provider ? [dashboardDataKeys.accountsDetail(provider)] : [];
  }

  async function refreshAfterAuditChange() {
    auditRefreshVersion.value += 1;
    useState<Record<string, unknown>>("account-quota-by-account-id", () => ({})).value = {};
    useState<Record<string, string>>("account-quota-error-by-account-id", () => ({})).value = {};
    useState<Record<string, boolean>>("account-quota-loading-by-account-id", () => ({})).value = {};
    useState<Record<string, boolean>>("account-quota-hydrated-account-ids", () => ({})).value = {};
    clearNuxtData();
    await refreshNuxtData([...auditShellRefreshDataKeys, ...getCurrentPageRefreshKeys()]);
  }

  return {
    audit,
    auditRefreshVersion,
    auditUser,
    dashboardMe,
    isAuditMode,
    refreshAfterAuditChange,
  };
}
