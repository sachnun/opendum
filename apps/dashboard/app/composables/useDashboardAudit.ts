import type { DashboardAuditInfo, DashboardMeData } from "../../lib/dashboard-api-types";

const emptyAuditInfo: DashboardAuditInfo = {
  active: false,
  readonly: false,
  user: null,
};

export function useDashboardAudit() {
  const dashboardMe = useState<DashboardMeData | null>("dashboard-me-state", () => null);

  const audit = computed(() => dashboardMe.value?.audit ?? emptyAuditInfo);
  const isAuditMode = computed(() => audit.value.active && Boolean(audit.value.user));
  const auditUser = computed(() => audit.value.user);

  async function refreshAfterAuditChange() {
    useState<Record<string, unknown>>("account-quota-by-account-id", () => ({})).value = {};
    useState<Record<string, string>>("account-quota-error-by-account-id", () => ({})).value = {};
    useState<Record<string, boolean>>("account-quota-loading-by-account-id", () => ({})).value = {};
    useState<Record<string, boolean>>("account-quota-hydrated-account-ids", () => ({})).value = {};
    await refreshNuxtData();
  }

  return {
    audit,
    auditUser,
    dashboardMe,
    isAuditMode,
    refreshAfterAuditChange,
  };
}
