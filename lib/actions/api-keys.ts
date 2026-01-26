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
export async function createApiKey(name?: string): Promise<ActionResult<{ id: string; key: string; keyPreview: string; name: string | null }>> {
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
      },
    };
  } catch (error) {
    console.error("Failed to create API key:", error);
    return { success: false, error: "Failed to create API key" };
  }
}

/**
 * Revoke (soft delete) an API key
 */
export async function revokeApiKey(id: string): Promise<ActionResult> {
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

    // Soft delete by setting isActive to false
    await prisma.proxyApiKey.update({
      where: { id },
      data: { isActive: false },
    });

    revalidatePath("/dashboard/api-keys");

    return { success: true, data: undefined };
  } catch (error) {
    console.error("Failed to revoke API key:", error);
    return { success: false, error: "Failed to revoke API key" };
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

    if (!apiKey.isActive) {
      return { success: false, error: "API key has been revoked" };
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
