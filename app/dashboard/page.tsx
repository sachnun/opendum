import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { AnalyticsCharts } from "@/components/dashboard/analytics/analytics-charts";
import { getAnalyticsData } from "@/lib/actions/analytics";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ apiKey?: string }>;
}) {
  const session = await auth();

  if (!session?.user?.id) {
    return null;
  }

  const apiKeys = await prisma.proxyApiKey.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      keyPreview: true,
    },
  });

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
