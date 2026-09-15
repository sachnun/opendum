import type { DashboardAuditInfo, DashboardMeData } from "../../lib/dashboard-api-types";

const emptyAuditInfo: DashboardAuditInfo = {
  active: false,
  readonly: false,
  user: null,
};

export function useDashboardAudit() {
  const dashboardMe = useState<DashboardMeData | null>(dashboardStateKeys.me, () => null);
  const auditRefreshVersion = useState(dashboardStateKeys.auditRefreshVersion, () => 0);

  const audit = computed(() => dashboardMe.value?.audit ?? emptyAuditInfo);
  const isAuditMode = computed(() => audit.value.active && Boolean(audit.value.user));
  const auditUser = computed(() => audit.value.user);

  async function refreshAfterAuditChange() {
    auditRefreshVersion.value += 1;
    useState<Record<string, unknown>>(dashboardStateKeys.quotaByAccountId, () => ({})).value = {};
    useState<Record<string, string>>(dashboardStateKeys.quotaErrorByAccountId, () => ({})).value = {};
    useState<Record<string, boolean>>(dashboardStateKeys.quotaLoadingByAccountId, () => ({})).value = {};
    useState<Record<string, boolean>>(dashboardStateKeys.quotaHydratedAccountIds, () => ({})).value = {};
    await refreshNuxtData();
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
