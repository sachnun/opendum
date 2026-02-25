import { Suspense } from "react";
import { getSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { proxyApiKey } from "@/lib/db/schema";
import { eq, desc } from "drizzle-orm";
import { AnalyticsCharts } from "@/components/dashboard/analytics/analytics-charts";
import { getAnalyticsData } from "@/lib/actions/analytics";
import DashboardLoading from "../../loading";
import { notFound } from "next/navigation";

interface AnalyticsContentProps {
  apiKeyId: string;
}

async function AnalyticsContent({ apiKeyId }: AnalyticsContentProps) {
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

  const validApiKey = apiKeys.some((key) => key.id === apiKeyId);

  if (!validApiKey) {
    notFound();
  }

  const initialAnalytics = await getAnalyticsData("24h", apiKeyId);
  const initialData = initialAnalytics.success ? initialAnalytics.data : null;

  return (
    <AnalyticsCharts
      initialData={initialData}
      apiKeys={apiKeys}
      initialApiKeyId={apiKeyId}
    />
  );
}

export default async function AnalistikApiKeyPage({
  params,
}: {
  params: Promise<{ apiKeyId: string }>;
}) {
  const { apiKeyId } = await params;

  return (
    <Suspense fallback={<DashboardLoading />}>
      <AnalyticsContent apiKeyId={apiKeyId} />
    </Suspense>
  );
}
