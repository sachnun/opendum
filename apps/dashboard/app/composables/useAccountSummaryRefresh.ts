const DASHBOARD_ACCOUNT_SUMMARY_REFRESH_EVENT = "dashboard:account-summary-refresh";

export function requestDashboardAccountSummaryRefresh() {
  if (!import.meta.client) return;
  window.dispatchEvent(new CustomEvent(DASHBOARD_ACCOUNT_SUMMARY_REFRESH_EVENT));
}

export function onDashboardAccountSummaryRefresh(callback: () => void) {
  if (!import.meta.client) return () => {};

  window.addEventListener(DASHBOARD_ACCOUNT_SUMMARY_REFRESH_EVENT, callback);
  return () => window.removeEventListener(DASHBOARD_ACCOUNT_SUMMARY_REFRESH_EVENT, callback);
}
