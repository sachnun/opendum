import { Suspense } from "react";
import { getSession } from "@/lib/auth";
import { db } from "@opendum/shared/db";
import { proxyApiKey } from "@opendum/shared/db/schema";
import { eq, desc } from "drizzle-orm";
import { AnalyticsCharts } from "@/components/dashboard/analytics/analytics-charts";
import { getAnalyticsData } from "@/lib/actions/analytics";
import DashboardLoading from "./loading";

async function AnalyticsContent() {
  const session = await getSession();

  if (!session?.user?.id) {
    return null;
  }

  const apiKeys = await db
    .select({
      id: proxyApiKey.id,
      name: proxyApiKey.name,
      keyPreview: proxyApiKey.keyPreview,
    })
    .from(proxyApiKey)
    .where(eq(proxyApiKey.userId, session.user.id))
    .orderBy(desc(proxyApiKey.createdAt));

  const initialAnalytics = await getAnalyticsData("24h");
  const initialData = initialAnalytics.success ? initialAnalytics.data : null;

  return (
    <AnalyticsCharts
      initialData={initialData}
      apiKeys={apiKeys}
      initialApiKeyId="all"
    />
  );
}

export default function DashboardPage() {
  return (
    <Suspense fallback={<DashboardLoading />}>
      <AnalyticsContent />
    </Suspense>
  );
}
