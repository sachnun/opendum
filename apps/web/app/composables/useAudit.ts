import type { AuditInfo, MeData } from "../../lib/api-types";

const emptyAuditInfo: AuditInfo = {
  active: false,
  readonly: false,
  user: null,
};

export function useAudit() {
  const me = useState<MeData | null>(stateKeys.me, () => null);
  const auditRefreshVersion = useState(stateKeys.auditRefreshVersion, () => 0);

  const audit = computed(() => me.value?.audit ?? emptyAuditInfo);
  const isAuditMode = computed(() => audit.value.active && Boolean(audit.value.user));
  const auditUser = computed(() => audit.value.user);

  async function refreshAfterAudit() {
    auditRefreshVersion.value += 1;
    useState<Record<string, unknown>>(stateKeys.quotaById, () => ({})).value = {};
    useState<Record<string, string>>(stateKeys.errorById, () => ({})).value = {};
    useState<Record<string, boolean>>(stateKeys.loadingById, () => ({})).value = {};
    await refreshNuxtData();
  }

  return {
    audit,
    auditRefreshVersion,
    auditUser,
    me,
    isAuditMode,
    refreshAfterAudit,
  };
}
