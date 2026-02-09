import { auth } from "@/lib/auth";
import { AnalyticsCharts } from "@/components/dashboard/analytics/analytics-charts";
import { getAnalyticsData } from "@/lib/actions/analytics";

export default async function DashboardPage() {
  const session = await auth();

  if (!session?.user?.id) {
    return null;
  }

  const initialAnalytics = await getAnalyticsData("24h");
  const initialData = initialAnalytics.success ? initialAnalytics.data : null;

  return <AnalyticsCharts initialData={initialData} />;
}
