import type { AuditInfo, MeData } from "../../lib/api-types";
import { injectRegistry } from "@effect/atom-vue";
import { invalidateAllQueries } from "../utils/atom";

const emptyAuditInfo: AuditInfo = {
  active: false,
  readonly: false,
  user: null,
};

export function useAudit() {
  const registry = injectRegistry();
  const me = useState<MeData | null>(stateKeys.me, () => null);
  const auditRefreshVersion = useState(stateKeys.auditRefreshVersion, () => 0);

  const audit = computed(() => me.value?.audit ?? emptyAuditInfo);
  const isAuditMode = computed(() => audit.value.active && Boolean(audit.value.user));
  const auditUser = computed(() => audit.value.user);

  async function refreshAfterAuditChange() {
    auditRefreshVersion.value += 1;
    useState<Record<string, unknown>>(stateKeys.quotaByAccountId, () => ({})).value = {};
    useState<Record<string, string>>(stateKeys.quotaErrorByAccountId, () => ({})).value = {};
    useState<Record<string, boolean>>(stateKeys.quotaLoadingByAccountId, () => ({})).value = {};
    invalidateAllQueries(registry);
  }

  return {
    audit,
    auditRefreshVersion,
    auditUser,
    me,
    isAuditMode,
    refreshAfterAuditChange,
  };
}
