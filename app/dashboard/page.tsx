import { getSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { proxyApiKey } from "@/lib/db/schema";
import { eq, desc } from "drizzle-orm";
import { AnalyticsCharts } from "@/components/dashboard/analytics/analytics-charts";
import { getAnalyticsData } from "@/lib/actions/analytics";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ apiKey?: string }>;
}) {
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

  const params = await searchParams;
  const requestedApiKeyId = params.apiKey;
  const initialApiKeyId =
    requestedApiKeyId && apiKeys.some((apiKey) => apiKey.id === requestedApiKeyId)
      ? requestedApiKeyId
      : "all";

  const initialAnalytics = await getAnalyticsData(
    "24h",
    initialApiKeyId === "all" ? undefined : initialApiKeyId
  );
  const initialData = initialAnalytics.success ? initialAnalytics.data : null;

  return (
    <AnalyticsCharts
      initialData={initialData}
      apiKeys={apiKeys}
      initialApiKeyId={initialApiKeyId}
    />
  );
}
