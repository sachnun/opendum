import { useCallback, useEffect, useState } from "react";
import type { DashboardAuditInfo, DashboardMeData } from "../lib/dashboard-api-types";
import { useDashboardApi } from "./useDashboardApi";
import { useDashboardDataInvalidation } from "./useDashboardDataInvalidation";

const emptyAuditInfo: DashboardAuditInfo = {
  active: false,
  readonly: false,
  user: null,
};

export function useDashboardMe() {
  const dashboardApi = useDashboardApi();
  const [dashboardMe, setDashboardMe] = useState<DashboardMeData | null>(null);

  const refresh = useCallback(async () => {
    try {
      const me = await dashboardApi.me.get();
      setDashboardMe(me);
    } catch {
      // ignore
    }
  }, [dashboardApi]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { dashboardMe, refresh };
}

export function useDashboardAudit() {
  const { dashboardMe, refresh } = useDashboardMe();
  const { refreshDashboardData } = useDashboardDataInvalidation();
  const [auditRefreshVersion, setAuditRefreshVersion] = useState(0);

  const audit = dashboardMe?.audit ?? emptyAuditInfo;
  const isAuditMode = audit.active && Boolean(audit.user);
  const auditUser = audit.user;

  const refreshAfterAuditChange = useCallback(async () => {
    setAuditRefreshVersion((v) => v + 1);
    await refresh();
    refreshDashboardData(["*"]);
  }, [refresh, refreshDashboardData]);

  return {
    audit,
    auditUser,
    dashboardMe,
    isAuditMode,
    auditRefreshVersion,
    refreshAfterAuditChange,
  };
}
