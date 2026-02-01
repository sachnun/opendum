import { auth } from "@/lib/auth";
import { AnalyticsCharts } from "./components/analytics-charts";
import { QuotaMonitor } from "./components/quota-monitor";

export default async function DashboardPage() {
  const session = await auth();

  if (!session?.user?.id) {
    return null;
  }

  return (
    <div className="space-y-4 md:space-y-6">
      <div>
        <h2 className="text-xl md:text-2xl font-bold tracking-tight">
          Welcome back, {session.user.name?.split(" ")[0]}!
        </h2>
        <p className="text-sm md:text-base text-muted-foreground">
          Here&apos;s an overview of your API proxy
        </p>
      </div>

      {/* Analytics Charts */}
      <AnalyticsCharts />

      {/* Antigravity Quota Monitor */}
      <QuotaMonitor />
    </div>
  );
}
