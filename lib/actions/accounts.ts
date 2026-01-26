"use server";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { encrypt } from "@/lib/encryption";
import { exchangeCodeForTokens, fetchUserInfo } from "@/lib/proxy/iflow-client";
import { revalidatePath } from "next/cache";

export type ActionResult<T = void> = 
  | { success: true; data: T }
  | { success: false; error: string };

const IFLOW_CALLBACK_PORT = "11451";

/**
 * Delete an iFlow account
 */
export async function deleteIflowAccount(id: string): Promise<ActionResult> {
  const session = await auth();

  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    // Verify ownership
    const account = await prisma.iflowAccount.findFirst({
      where: { id, userId: session.user.id },
    });

    if (!account) {
      return { success: false, error: "Account not found" };
    }

    await prisma.iflowAccount.delete({ where: { id } });

    revalidatePath("/dashboard/accounts");

    return { success: true, data: undefined };
  } catch (error) {
    console.error("Failed to delete account:", error);
    return { success: false, error: "Failed to delete account" };
  }
}

/**
 * Update an iFlow account
 */
export async function updateIflowAccount(
  id: string, 
  data: { name?: string; isActive?: boolean }
): Promise<ActionResult> {
  const session = await auth();

  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    // Verify ownership
    const account = await prisma.iflowAccount.findFirst({
      where: { id, userId: session.user.id },
    });

    if (!account) {
      return { success: false, error: "Account not found" };
    }

    await prisma.iflowAccount.update({
      where: { id },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.isActive !== undefined && { isActive: data.isActive }),
      },
    });

    revalidatePath("/dashboard/accounts");

    return { success: true, data: undefined };
  } catch (error) {
    console.error("Failed to update account:", error);
    return { success: false, error: "Failed to update account" };
  }
}

/**
 * Exchange iFlow OAuth callback URL for tokens and create/update account
 */
export async function exchangeIflowOAuthCode(
  callbackUrl: string
): Promise<ActionResult<{ email: string; isUpdate: boolean }>> {
  const session = await auth();

  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  if (!callbackUrl || typeof callbackUrl !== "string") {
    return { success: false, error: "Callback URL is required" };
  }

  try {
    // Parse the callback URL to extract the code
    let url: URL;
    try {
      url = new URL(callbackUrl);
    } catch {
      return { success: false, error: "Invalid URL format" };
    }

    const code = url.searchParams.get("code");
    if (!code) {
      return { 
        success: false, 
        error: "No authorization code found in URL. Make sure you copied the complete URL from your browser." 
      };
    }

    // Check for error in URL
    const error = url.searchParams.get("error");
    if (error) {
      return { success: false, error: `iFlow OAuth error: ${error}` };
    }

    // The redirect URI must match exactly what was used in the authorization request
    const redirectUri = `http://localhost:${IFLOW_CALLBACK_PORT}/oauth2callback`;

    // Exchange code for tokens
    console.log("Exchanging code for tokens...");
    const tokens = await exchangeCodeForTokens(code, redirectUri);
    console.log("Token exchange successful");

    // Fetch user info to get API key
    console.log("Fetching user info...");
    const userInfo = await fetchUserInfo(tokens.access_token);
    console.log("User info fetched:", userInfo.email);

    // Calculate expiry date
    const expiresAt = new Date(Date.now() + (tokens.expires_in || 3600) * 1000);

    // Check if account with this email already exists for this user
    const existingAccount = await prisma.iflowAccount.findFirst({
      where: {
        userId: session.user.id,
        email: userInfo.email,
      },
    });

    if (existingAccount) {
      // Update existing account
      await prisma.iflowAccount.update({
        where: { id: existingAccount.id },
        data: {
          accessToken: encrypt(tokens.access_token),
          refreshToken: encrypt(tokens.refresh_token),
          apiKey: encrypt(userInfo.apiKey),
          expiresAt,
          isActive: true,
        },
      });

      revalidatePath("/dashboard/accounts");

      return {
        success: true,
        data: {
          email: userInfo.email,
          isUpdate: true,
        },
      };
    } else {
      // Create new account
      const accountCount = await prisma.iflowAccount.count({
        where: { userId: session.user.id },
      });

      await prisma.iflowAccount.create({
        data: {
          userId: session.user.id,
          name: userInfo.email ? `iFlow (${userInfo.email})` : `iFlow Account ${accountCount + 1}`,
          accessToken: encrypt(tokens.access_token),
          refreshToken: encrypt(tokens.refresh_token),
          apiKey: encrypt(userInfo.apiKey),
          expiresAt,
          email: userInfo.email,
          isActive: true,
        },
      });

      revalidatePath("/dashboard/accounts");

      return {
        success: true,
        data: {
          email: userInfo.email,
          isUpdate: false,
        },
      };
    }
  } catch (err) {
    console.error("Failed to exchange OAuth code:", err);
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    return { success: false, error: errorMessage };
  }
}
