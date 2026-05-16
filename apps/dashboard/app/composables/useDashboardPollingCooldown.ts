const DEFAULT_DASHBOARD_POLLING_COOLDOWN_MS = 30_000;

export function useDashboardPollingCooldown() {
  const startedAtMs = useState<number>("dashboard-polling-cooldown-started-at-ms", () => 0);
  const durationMs = useState<number>("dashboard-polling-cooldown-duration-ms", () => DEFAULT_DASHBOARD_POLLING_COOLDOWN_MS);
  const active = useState<boolean>("dashboard-polling-cooldown-active", () => false);
  const refreshing = useState<boolean>("dashboard-polling-cooldown-refreshing", () => false);

  function start(duration = DEFAULT_DASHBOARD_POLLING_COOLDOWN_MS) {
    durationMs.value = duration;
    startedAtMs.value = Date.now();
    active.value = true;
  }

  function stop() {
    active.value = false;
    refreshing.value = false;
  }

  function setRefreshing(value: boolean) {
    refreshing.value = value;
  }

  return {
    active,
    durationMs,
    refreshing,
    setRefreshing,
    start,
    startedAtMs,
    stop,
  };
}
