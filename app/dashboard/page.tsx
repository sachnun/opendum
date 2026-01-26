import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { User, Key, Activity } from "lucide-react";
import { AnalyticsCharts } from "./components/analytics-charts";

export default async function DashboardPage() {
  const session = await auth();

  if (!session?.user?.id) {
    return null;
  }

  // Get stats
  const [accountCount, apiKeyCount, recentLogs] = await Promise.all([
    prisma.iflowAccount.count({
      where: { userId: session.user.id, isActive: true },
    }),
    prisma.proxyApiKey.count({
      where: { userId: session.user.id, isActive: true },
    }),
    prisma.usageLog.count({
      where: {
        userId: session.user.id,
        createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
    }),
  ]);

  const stats = [
    {
      title: "Active iFlow Accounts",
      value: accountCount,
      description: "Connected accounts for load balancing",
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
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">
          Welcome back, {session.user.name?.split(" ")[0]}!
        </h2>
        <p className="text-muted-foreground">
          Here&apos;s an overview of your iFlow proxy
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
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

      <Card>
        <CardHeader>
          <CardTitle>Quick Start</CardTitle>
          <CardDescription>Get started with your iFlow proxy</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-lg border p-4">
            <h3 className="font-semibold">1. Add iFlow Accounts</h3>
            <p className="text-sm text-muted-foreground">
              Connect your iFlow accounts to enable load balancing across multiple accounts.
            </p>
          </div>
          <div className="rounded-lg border p-4">
            <h3 className="font-semibold">2. Generate API Key</h3>
            <p className="text-sm text-muted-foreground">
              Create a proxy API key to authenticate your requests.
            </p>
          </div>
          <div className="rounded-lg border p-4">
            <h3 className="font-semibold">3. Configure Your Client</h3>
            <p className="text-sm text-muted-foreground">
              Use your API key with Claude Code or other OpenAI-compatible clients.
            </p>
            <pre className="mt-2 rounded bg-muted p-2 text-xs overflow-x-auto">
{`ANTHROPIC_BASE_URL=https://your-domain.com
ANTHROPIC_AUTH_TOKEN=your-proxy-api-key`}
            </pre>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
