import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { User, Key, Activity } from "lucide-react";
import { AnalyticsCharts } from "./components/analytics-charts";
import { QuotaMonitor } from "./components/quota-monitor";

export default async function DashboardPage() {
  const session = await auth();

  if (!session?.user?.id) {
    return null;
  }

  // Get stats
  const now = new Date();
  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const [accountCount, apiKeyCount, recentLogs] = await Promise.all([
    prisma.providerAccount.count({
      where: { userId: session.user.id, isActive: true },
    }),
    prisma.proxyApiKey.count({
      where: { userId: session.user.id, isActive: true },
    }),
    prisma.usageLog.count({
      where: {
        userId: session.user.id,
        createdAt: { gte: twentyFourHoursAgo },
      },
    }),
  ]);

  const stats = [
    {
      title: "Active Accounts",
      value: accountCount,
      description: "Connected provider accounts for load balancing",
      icon: User,
    },
    {
      title: "Active API Keys",
      value: apiKeyCount,
      description: "Keys for proxy access",
      icon: Key,
    },
    {
      title: "Requests (24h)",
      value: recentLogs,
      description: "API requests in last 24 hours",
      icon: Activity,
    },
  ];

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

      <div className="grid gap-3 sm:gap-4 grid-cols-1 sm:grid-cols-2 md:grid-cols-3">
        {stats.map((stat) => (
          <Card key={stat.title}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">{stat.title}</CardTitle>
              <stat.icon className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stat.value}</div>
              <p className="text-xs text-muted-foreground">{stat.description}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Analytics Charts */}
      <AnalyticsCharts />

      {/* Antigravity Quota Monitor */}
      <QuotaMonitor />
    </div>
  );
}
