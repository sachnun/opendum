"use server";

import { revalidatePath } from "next/cache";
import { getSession } from "@/lib/auth";
import { db } from "@opendum/shared/db";
import { pinnedProvider } from "@opendum/shared/db/schema";
import { eq, and } from "drizzle-orm";
import type { ProviderAccountKey } from "@/lib/provider-accounts";
import { PROVIDER_ACCOUNT_DEFINITIONS } from "@/lib/provider-accounts";

type ActionResult<T = void> =
  | { success: true; data: T }
  | { success: false; error: string };

const VALID_PROVIDER_KEYS = new Set<string>(
  PROVIDER_ACCOUNT_DEFINITIONS.map((d) => d.key)
);

export async function togglePinnedProvider(
  providerKey: string
): Promise<ActionResult<{ providerKey: string; pinned: boolean }>> {
  const session = await getSession();

  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  if (!VALID_PROVIDER_KEYS.has(providerKey)) {
    return { success: false, error: "Invalid provider" };
  }

  try {
    const [existing] = await db
      .select({ id: pinnedProvider.id })
      .from(pinnedProvider)
      .where(
        and(
          eq(pinnedProvider.userId, session.user.id),
          eq(pinnedProvider.providerKey, providerKey)
        )
      )
      .limit(1);

    if (existing) {
      await db
        .delete(pinnedProvider)
        .where(eq(pinnedProvider.id, existing.id));

      revalidatePath("/dashboard", "layout");
      return {
        success: true,
        data: { providerKey, pinned: false },
      };
    }

    await db.insert(pinnedProvider).values({
      userId: session.user.id,
      providerKey,
    });

    revalidatePath("/dashboard", "layout");
    return {
      success: true,
      data: { providerKey, pinned: true },
    };
  } catch (error) {
    console.error("Failed to toggle pinned provider:", error);
    return { success: false, error: "Failed to update pinned provider" };
  }
}

export async function getPinnedProviders(): Promise<
  ActionResult<{ providers: ProviderAccountKey[] }>
> {
  const session = await getSession();

  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    const rows = await db
      .select({ providerKey: pinnedProvider.providerKey })
      .from(pinnedProvider)
      .where(eq(pinnedProvider.userId, session.user.id));

    const providers = rows
      .map((r: { providerKey: string }) => r.providerKey)
      .filter((k: string): k is ProviderAccountKey => VALID_PROVIDER_KEYS.has(k));

    return { success: true, data: { providers } };
  } catch (error) {
    console.error("Failed to get pinned providers:", error);
    return { success: false, error: "Failed to get pinned providers" };
  }
}
