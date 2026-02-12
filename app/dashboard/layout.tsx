import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { redirect } from "next/navigation";
import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";
import {
  MODEL_FAMILY_NAV_ITEMS,
  getModelFamily,
} from "@/lib/model-families";
import { getAllModels } from "@/lib/proxy/models";
import type {
  ModelFamilyCounts,
  ProviderAccountCounts,
} from "@/lib/navigation";
import { Toaster } from "@/components/ui/sonner";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  if (!session?.user?.id) {
    redirect("/");
  }

  const groupedAccountCounts = await prisma.providerAccount.groupBy({
    by: ["provider"],
    where: { userId: session.user.id },
    _count: {
      _all: true,
    },
  });

  const accountCounts: ProviderAccountCounts = {
    antigravity: 0,
    codex: 0,
    iflow: 0,
    kiro: 0,
    gemini_cli: 0,
    qwen_code: 0,
    nvidia_nim: 0,
    ollama_cloud: 0,
    openrouter: 0,
  };

  for (const item of groupedAccountCounts) {
    switch (item.provider) {
      case "antigravity":
        accountCounts.antigravity = item._count._all;
        break;
      case "codex":
        accountCounts.codex = item._count._all;
        break;
      case "iflow":
        accountCounts.iflow = item._count._all;
        break;
      case "kiro":
        accountCounts.kiro = item._count._all;
        break;
      case "gemini_cli":
        accountCounts.gemini_cli = item._count._all;
        break;
      case "qwen_code":
        accountCounts.qwen_code = item._count._all;
        break;
      case "nvidia_nim":
        accountCounts.nvidia_nim = item._count._all;
        break;
      case "ollama_cloud":
        accountCounts.ollama_cloud = item._count._all;
        break;
      case "openrouter":
        accountCounts.openrouter = item._count._all;
        break;
      default:
        break;
    }
  }

  const familyAnchorByName = new Map(
    MODEL_FAMILY_NAV_ITEMS.map((item) => [item.name, item.anchorId] as const)
  );

  const modelFamilyCounts: ModelFamilyCounts = {};
  for (const item of MODEL_FAMILY_NAV_ITEMS) {
    modelFamilyCounts[item.anchorId] = 0;
  }

  for (const modelId of getAllModels()) {
    const family = getModelFamily(modelId);
    const anchorId = familyAnchorByName.get(family);
    if (!anchorId) {
      continue;
    }

    modelFamilyCounts[anchorId] += 1;
  }

  return (
    <div className="relative flex min-h-svh bg-background">
      <Sidebar accountCounts={accountCounts} modelFamilyCounts={modelFamilyCounts} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Header accountCounts={accountCounts} modelFamilyCounts={modelFamilyCounts} />
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-7xl px-5 pb-8 pt-5 sm:px-6 lg:px-8">
            {children}
          </div>
        </main>
      </div>
      <Toaster />
    </div>
  );
}
