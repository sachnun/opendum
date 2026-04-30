import { refreshTokens } from "../lib/cron/refresh-tokens";

export default defineTask({
  meta: {
    name: "refresh-tokens",
    description: "Refresh expiring OAuth provider tokens",
  },
  async run() {
    const result = await refreshTokens();
    console.log(
      `[cron] refresh-tokens refreshed=${result.summary.refreshed} skipped=${result.summary.skipped} failed=${result.summary.failed} duration=${result.summary.duration}ms`,
    );

    return result.summary;
  },
});
