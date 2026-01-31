"use server";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { generateApiKey, hashString, getKeyPreview, encrypt, decrypt } from "@/lib/encryption";
import { revalidatePath } from "next/cache";

export type ActionResult<T = void> = 
  | { success: true; data: T }
  | { success: false; error: string };

/**
 * Create a new API key
 */
export async function createApiKey(
  name?: string,
  expiresAt?: Date | null
): Promise<ActionResult<{ id: string; key: string; keyPreview: string; name: string | null; expiresAt: Date | null }>> {
  const session = await auth();

  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    // Generate API key
    const key = generateApiKey();
    const keyHash = hashString(key);
    const keyPreview = getKeyPreview(key);
    const encryptedKey = encrypt(key);

    const trimmedName = name?.trim() || null;

    // Create in database
    const apiKey = await prisma.proxyApiKey.create({
      data: {
        userId: session.user.id,
        keyHash,
        keyPreview,
        encryptedKey,
        name: trimmedName ?? undefined,
        expiresAt: expiresAt ?? undefined,
      },
    });

    revalidatePath("/dashboard/api-keys");

    return {
      success: true,
      data: {
        id: apiKey.id,
        key,
        keyPreview,
        name: apiKey.name,
        expiresAt: apiKey.expiresAt,
      },
    };
  } catch (error) {
    console.error("Failed to create API key:", error);
    return { success: false, error: "Failed to create API key" };
  }
}

/**
 * Toggle API key active status (enable/disable)
 */
export async function toggleApiKey(id: string): Promise<ActionResult> {
  const session = await auth();

  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    // Find and verify ownership
    const apiKey = await prisma.proxyApiKey.findFirst({
      where: { id, userId: session.user.id },
    });

    if (!apiKey) {
      return { success: false, error: "API key not found" };
    }

    // Toggle isActive
    await prisma.proxyApiKey.update({
      where: { id },
      data: { isActive: !apiKey.isActive },
    });

    revalidatePath("/dashboard/api-keys");

    return { success: true, data: undefined };
  } catch (error) {
    console.error("Failed to toggle API key:", error);
    return { success: false, error: "Failed to toggle API key" };
  }
}

/**
 * Delete an API key permanently
 */
export async function deleteApiKey(id: string): Promise<ActionResult> {
  const session = await auth();

  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    // Find and verify ownership
    const apiKey = await prisma.proxyApiKey.findFirst({
      where: { id, userId: session.user.id },
    });

    if (!apiKey) {
      return { success: false, error: "API key not found" };
    }

    // Delete permanently
    await prisma.proxyApiKey.delete({
      where: { id },
    });

    revalidatePath("/dashboard/api-keys");

    return { success: true, data: undefined };
  } catch (error) {
    console.error("Failed to delete API key:", error);
    return { success: false, error: "Failed to delete API key" };
  }
}

/**
 * Update API key name
 */
export async function updateApiKeyName(id: string, name: string): Promise<ActionResult<{ name: string | null }>> {
  const session = await auth();

  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    // Find and verify ownership
    const apiKey = await prisma.proxyApiKey.findFirst({
      where: { id, userId: session.user.id },
    });

    if (!apiKey) {
      return { success: false, error: "API key not found" };
    }

    const trimmedName = name?.trim() || null;

    // Update the name
    const updatedKey = await prisma.proxyApiKey.update({
      where: { id },
      data: { name: trimmedName },
    });

    revalidatePath("/dashboard/api-keys");

    return { success: true, data: { name: updatedKey.name } };
  } catch (error) {
    console.error("Failed to update API key name:", error);
    return { success: false, error: "Failed to update API key name" };
  }
}

/**
 * Reveal the full API key
 */
export async function revealApiKey(id: string): Promise<ActionResult<{ key: string }>> {
  const session = await auth();

  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    // Find API key and verify ownership
    const apiKey = await prisma.proxyApiKey.findFirst({
      where: { id, userId: session.user.id },
      select: {
        id: true,
        encryptedKey: true,
        isActive: true,
      },
    });

    if (!apiKey) {
      return { success: false, error: "API key not found" };
    }

    // Check if encryptedKey exists (old keys might not have it)
    if (!apiKey.encryptedKey) {
      return { 
        success: false, 
        error: "This API key was created before the reveal feature. Please generate a new key." 
      };
    }

    // Decrypt and return the key
    const key = decrypt(apiKey.encryptedKey);

    return { success: true, data: { key } };
  } catch (error) {
    console.error("Failed to reveal API key:", error);
    return { success: false, error: "Failed to reveal API key" };
  }
}
