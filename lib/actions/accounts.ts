"use server";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { encrypt, decrypt } from "@/lib/encryption";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { iflowProvider } from "@/lib/proxy/providers/iflow";
import {
  IFLOW_REDIRECT_URI,
  IFLOW_OAUTH_AUTHORIZE_URL,
  IFLOW_CLIENT_ID,
} from "@/lib/proxy/providers/iflow/constants";
import { antigravityProvider } from "@/lib/proxy/providers/antigravity";
import {
  ANTIGRAVITY_REDIRECT_URI,
  ANTIGRAVITY_CLIENT_ID,
  ANTIGRAVITY_SCOPES,
} from "@/lib/proxy/providers/antigravity/constants";
import { geminiCliProvider } from "@/lib/proxy/providers/gemini-cli";
import {
  GEMINI_CLI_REDIRECT_URI,
  GEMINI_CLI_CLIENT_ID,
  GEMINI_CLI_SCOPES,
} from "@/lib/proxy/providers/gemini-cli/constants";
import {
  initiateDeviceCodeFlow,
  pollDeviceCodeAuthorization,
} from "@/lib/proxy/providers/qwen-code";
import {
  initiateCodexDeviceCodeFlow,
  pollCodexDeviceCodeAuthorization,
  codexProvider,
  generateCodeVerifier,
  generateCodeChallenge,
  CODEX_CLIENT_ID,
  CODEX_OAUTH_AUTHORIZE_ENDPOINT,
  CODEX_BROWSER_REDIRECT_URI,
  CODEX_OAUTH_SCOPE,
  CODEX_ORIGINATOR,
} from "@/lib/proxy/providers/codex";

export type ActionResult<T = void> = 
  | { success: true; data: T }
  | { success: false; error: string };

const CODEX_OAUTH_COOKIE_NAME = "codex_oauth_ctx";

interface CodexOAuthContext {
  state: string;
  codeVerifier: string;
}

function generateCodexState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(bytes).toString("base64url");
}

/**
 * Delete a provider account
 */
export async function deleteProviderAccount(id: string): Promise<ActionResult> {
  const session = await auth();

  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    // Verify ownership
    const account = await prisma.providerAccount.findFirst({
      where: { id, userId: session.user.id },
    });

    if (!account) {
      return { success: false, error: "Account not found" };
    }

    await prisma.providerAccount.delete({ where: { id } });

    revalidatePath("/dashboard/accounts");

    return { success: true, data: undefined };
  } catch (error) {
    console.error("Failed to delete account:", error);
    return { success: false, error: "Failed to delete account" };
  }
}

/**
 * Update a provider account
 */
export async function updateProviderAccount(
  id: string, 
  data: { name?: string; isActive?: boolean }
): Promise<ActionResult> {
  const session = await auth();

  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    // Verify ownership
    const account = await prisma.providerAccount.findFirst({
      where: { id, userId: session.user.id },
    });

    if (!account) {
      return { success: false, error: "Account not found" };
    }

    await prisma.providerAccount.update({
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
 * Exchange Iflow OAuth callback URL for tokens and create/update account
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
      return { success: false, error: `Iflow OAuth error: ${error}` };
    }

    // Exchange code for tokens using the provider
    console.log("Exchanging code for tokens...");
    const oauthResult = await iflowProvider.exchangeCode(code, IFLOW_REDIRECT_URI);
    console.log("Token exchange successful");

    // Check if account with this email already exists for this user
    const existingAccount = await prisma.providerAccount.findFirst({
      where: {
        userId: session.user.id,
        provider: "iflow",
        email: oauthResult.email,
      },
    });

    if (existingAccount) {
      // Update existing account
      await prisma.providerAccount.update({
        where: { id: existingAccount.id },
        data: {
          accessToken: encrypt(oauthResult.accessToken),
          refreshToken: encrypt(oauthResult.refreshToken),
          apiKey: oauthResult.apiKey ? encrypt(oauthResult.apiKey) : null,
          expiresAt: oauthResult.expiresAt,
          isActive: true,
        },
      });

      revalidatePath("/dashboard/accounts");

      return {
        success: true,
        data: {
          email: oauthResult.email,
          isUpdate: true,
        },
      };
    } else {
      // Create new account
      const accountCount = await prisma.providerAccount.count({
        where: { userId: session.user.id, provider: "iflow" },
      });

      await prisma.providerAccount.create({
        data: {
          userId: session.user.id,
          provider: "iflow",
          name: oauthResult.email ? `Iflow (${oauthResult.email})` : `Iflow Account ${accountCount + 1}`,
          accessToken: encrypt(oauthResult.accessToken),
          refreshToken: encrypt(oauthResult.refreshToken),
          apiKey: oauthResult.apiKey ? encrypt(oauthResult.apiKey) : null,
          expiresAt: oauthResult.expiresAt,
          email: oauthResult.email,
          isActive: true,
        },
      });

      revalidatePath("/dashboard/accounts");

      return {
        success: true,
        data: {
          email: oauthResult.email,
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

/**
 * Get all accounts for the current user grouped by provider
 */
export async function getAccountsByProvider(): Promise<
  ActionResult<Record<string, Array<{
    id: string;
    name: string;
    email: string | null;
    isActive: boolean;
    lastUsedAt: Date | null;
    requestCount: number;
    tier: string | null;
  }>>>
> {
  const session = await auth();

  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    const accounts = await prisma.providerAccount.findMany({
      where: { userId: session.user.id },
      select: {
        id: true,
        provider: true,
        name: true,
        email: true,
        isActive: true,
        lastUsedAt: true,
        requestCount: true,
        tier: true,
      },
      orderBy: { createdAt: "asc" },
    });

    const grouped: Record<string, typeof accounts> = {};
    for (const account of accounts) {
      if (!grouped[account.provider]) {
        grouped[account.provider] = [];
      }
      grouped[account.provider].push(account);
    }

    return { success: true, data: grouped };
  } catch (error) {
    console.error("Failed to get accounts:", error);
    return { success: false, error: "Failed to get accounts" };
  }
}

// Backwards compatibility aliases
export const deleteIflowAccount = deleteProviderAccount;
export const updateIflowAccount = updateProviderAccount;

/**
 * Reset account error status to active
 * Clears consecutive errors and restores status to active
 */
export async function resetAccountStatus(id: string): Promise<ActionResult> {
  const session = await auth();

  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    // Verify ownership
    const account = await prisma.providerAccount.findFirst({
      where: { id, userId: session.user.id },
    });

    if (!account) {
      return { success: false, error: "Account not found" };
    }

    await prisma.providerAccount.update({
      where: { id },
      data: {
        status: "active",
        statusReason: null,
        statusChangedAt: new Date(),
        consecutiveErrors: 0,
      },
    });

    revalidatePath("/dashboard/accounts");

    return { success: true, data: undefined };
  } catch (error) {
    console.error("Failed to reset account status:", error);
    return { success: false, error: "Failed to reset account status" };
  }
}

/**
 * Clear all error history for an account (reset counters)
 */
export async function clearAccountErrors(id: string): Promise<ActionResult> {
  const session = await auth();

  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    // Verify ownership
    const account = await prisma.providerAccount.findFirst({
      where: { id, userId: session.user.id },
    });

    if (!account) {
      return { success: false, error: "Account not found" };
    }

    await prisma.providerAccount.update({
      where: { id },
      data: {
        status: "active",
        statusReason: null,
        statusChangedAt: new Date(),
        errorCount: 0,
        consecutiveErrors: 0,
        lastErrorAt: null,
        lastErrorMessage: null,
        lastErrorCode: null,
      },
    });

    revalidatePath("/dashboard/accounts");

    return { success: true, data: undefined };
  } catch (error) {
    console.error("Failed to clear account errors:", error);
    return { success: false, error: "Failed to clear account errors" };
  }
}

/**
 * Get Iflow OAuth authorization URL
 */
export async function getIflowAuthUrl(): Promise<ActionResult<{ authUrl: string }>> {
  const session = await auth();

  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  const authParams = new URLSearchParams({
    loginMethod: "phone",
    type: "phone",
    redirect: IFLOW_REDIRECT_URI,
    client_id: IFLOW_CLIENT_ID,
  });

  const authUrl = `${IFLOW_OAUTH_AUTHORIZE_URL}?${authParams.toString()}`;

  return { success: true, data: { authUrl } };
}

/**
 * Get Antigravity (Google) OAuth authorization URL
 */
export async function getAntigravityAuthUrl(): Promise<ActionResult<{ authUrl: string }>> {
  const session = await auth();

  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  const params = new URLSearchParams({
    client_id: ANTIGRAVITY_CLIENT_ID,
    redirect_uri: ANTIGRAVITY_REDIRECT_URI,
    response_type: "code",
    scope: ANTIGRAVITY_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
  });

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;

  return { success: true, data: { authUrl } };
}

/**
 * Exchange Antigravity OAuth callback URL for tokens and create/update account
 */
export async function exchangeAntigravityOAuthCode(
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
      return { success: false, error: `Google OAuth error: ${error}` };
    }

    // Exchange code for tokens using the provider
    console.log("Exchanging Antigravity code for tokens...");
    const oauthResult = await antigravityProvider.exchangeCode(
      code, 
      ANTIGRAVITY_REDIRECT_URI
    );
    console.log("Antigravity token exchange successful");

    // Check if account with this email already exists for this user
    const existingAccount = await prisma.providerAccount.findFirst({
      where: {
        userId: session.user.id,
        provider: "antigravity",
        email: oauthResult.email,
      },
    });

    if (existingAccount) {
      // Update existing account
      await prisma.providerAccount.update({
        where: { id: existingAccount.id },
        data: {
          accessToken: encrypt(oauthResult.accessToken),
          refreshToken: encrypt(oauthResult.refreshToken),
          expiresAt: oauthResult.expiresAt,
          projectId: oauthResult.projectId,
          tier: oauthResult.tier,
          isActive: true,
        },
      });

      revalidatePath("/dashboard/accounts");

      return {
        success: true,
        data: {
          email: oauthResult.email,
          isUpdate: true,
        },
      };
    } else {
      // Create new account
      const accountCount = await prisma.providerAccount.count({
        where: { userId: session.user.id, provider: "antigravity" },
      });

      await prisma.providerAccount.create({
        data: {
          userId: session.user.id,
          provider: "antigravity",
          name: oauthResult.email 
            ? `Antigravity (${oauthResult.email})` 
            : `Antigravity Account ${accountCount + 1}`,
          accessToken: encrypt(oauthResult.accessToken),
          refreshToken: encrypt(oauthResult.refreshToken),
          expiresAt: oauthResult.expiresAt,
          email: oauthResult.email,
          projectId: oauthResult.projectId,
          tier: oauthResult.tier,
          isActive: true,
        },
      });

      revalidatePath("/dashboard/accounts");

      return {
        success: true,
        data: {
          email: oauthResult.email,
          isUpdate: false,
        },
      };
    }
  } catch (err) {
    console.error("Failed to exchange Antigravity OAuth code:", err);
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    return { success: false, error: errorMessage };
  }
}

/**
 * Initiate Qwen Code Device Code Flow
 * Returns device code info including URL for user to visit
 */
export async function initiateQwenCodeAuth(): Promise<
  ActionResult<{
    deviceCode: string;
    userCode: string;
    verificationUrl: string;
    verificationUrlComplete: string;
    expiresIn: number;
    interval: number;
    codeVerifier: string;
  }>
> {
  const session = await auth();

  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    const deviceCodeInfo = await initiateDeviceCodeFlow();

    return {
      success: true,
      data: deviceCodeInfo,
    };
  } catch (err) {
    console.error("Failed to initiate Qwen Code auth:", err);
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    return { success: false, error: errorMessage };
  }
}

/**
 * Poll Qwen Code device code authorization status
 * Call this periodically until it returns success or error
 */
export async function pollQwenCodeAuth(
  deviceCode: string,
  codeVerifier: string
): Promise<
  ActionResult<
    | { status: "pending" }
    | { status: "success"; email: string; isUpdate: boolean }
    | { status: "error"; message: string }
  >
> {
  const session = await auth();

  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    const result = await pollDeviceCodeAuthorization(deviceCode, codeVerifier);

    if ("pending" in result) {
      return { success: true, data: { status: "pending" } };
    }

    if ("error" in result) {
      return { success: true, data: { status: "error", message: result.error } };
    }

    // Success - we have tokens, now save them
    const oauthResult = result;

    // For Qwen Code, email is not automatically provided
    // We'll use a placeholder and user can update later
    const email = oauthResult.email || `qwen-${Date.now()}`;

    // Check if account with this email already exists for this user
    const existingAccount = await prisma.providerAccount.findFirst({
      where: {
        userId: session.user.id,
        provider: "qwen_code",
        email: email,
      },
    });

    if (existingAccount) {
      // Update existing account
      await prisma.providerAccount.update({
        where: { id: existingAccount.id },
        data: {
          accessToken: encrypt(oauthResult.accessToken),
          refreshToken: encrypt(oauthResult.refreshToken),
          expiresAt: oauthResult.expiresAt,
          isActive: true,
        },
      });

      revalidatePath("/dashboard/accounts");

      return {
        success: true,
        data: {
          status: "success",
          email: email,
          isUpdate: true,
        },
      };
    } else {
      // Create new account
      const accountCount = await prisma.providerAccount.count({
        where: { userId: session.user.id, provider: "qwen_code" },
      });

      await prisma.providerAccount.create({
        data: {
          userId: session.user.id,
          provider: "qwen_code",
          name: `Qwen Code Account ${accountCount + 1}`,
          accessToken: encrypt(oauthResult.accessToken),
          refreshToken: encrypt(oauthResult.refreshToken),
          expiresAt: oauthResult.expiresAt,
          email: email,
          isActive: true,
        },
      });

      revalidatePath("/dashboard/accounts");

      return {
        success: true,
        data: {
          status: "success",
          email: email,
          isUpdate: false,
        },
      };
    }
  } catch (err) {
    console.error("Failed to poll Qwen Code auth:", err);
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    return { success: false, error: errorMessage };
  }
}

/**
 * Complete Qwen Code auth with email identifier
 * Call this after successful auth to set the email/identifier
 */
export async function setQwenCodeAccountEmail(
  accountId: string,
  email: string
): Promise<ActionResult> {
  const session = await auth();

  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    // Verify ownership
    const account = await prisma.providerAccount.findFirst({
      where: { id: accountId, userId: session.user.id, provider: "qwen_code" },
    });

    if (!account) {
      return { success: false, error: "Account not found" };
    }

    await prisma.providerAccount.update({
      where: { id: accountId },
      data: {
        email: email.trim(),
        name: `Qwen Code (${email.trim()})`,
      },
    });

    revalidatePath("/dashboard/accounts");

    return { success: true, data: undefined };
  } catch (error) {
    console.error("Failed to set Qwen Code account email:", error);
    return { success: false, error: "Failed to update account" };
  }
}

/**
 * Get Gemini CLI (Google) OAuth authorization URL
 */
export async function getGeminiCliAuthUrl(): Promise<ActionResult<{ authUrl: string }>> {
  const session = await auth();

  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  const params = new URLSearchParams({
    client_id: GEMINI_CLI_CLIENT_ID,
    redirect_uri: GEMINI_CLI_REDIRECT_URI,
    response_type: "code",
    scope: GEMINI_CLI_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
  });

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;

  return { success: true, data: { authUrl } };
}

/**
 * Exchange Gemini CLI OAuth callback URL for tokens and create/update account
 */
export async function exchangeGeminiCliOAuthCode(
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
      return { success: false, error: `Google OAuth error: ${error}` };
    }

    // Exchange code for tokens using the provider
    console.log("Exchanging Gemini CLI code for tokens...");
    const oauthResult = await geminiCliProvider.exchangeCode(
      code, 
      GEMINI_CLI_REDIRECT_URI
    );
    console.log("Gemini CLI token exchange successful");

    // Check if account with this email already exists for this user
    const existingAccount = await prisma.providerAccount.findFirst({
      where: {
        userId: session.user.id,
        provider: "gemini_cli",
        email: oauthResult.email,
      },
    });

    if (existingAccount) {
      // Update existing account
      await prisma.providerAccount.update({
        where: { id: existingAccount.id },
        data: {
          accessToken: encrypt(oauthResult.accessToken),
          refreshToken: encrypt(oauthResult.refreshToken),
          expiresAt: oauthResult.expiresAt,
          projectId: oauthResult.projectId,
          tier: oauthResult.tier,
          isActive: true,
        },
      });

      revalidatePath("/dashboard/accounts");

      return {
        success: true,
        data: {
          email: oauthResult.email,
          isUpdate: true,
        },
      };
    } else {
      // Create new account
      const accountCount = await prisma.providerAccount.count({
        where: { userId: session.user.id, provider: "gemini_cli" },
      });

      await prisma.providerAccount.create({
        data: {
          userId: session.user.id,
          provider: "gemini_cli",
          name: oauthResult.email 
            ? `Gemini CLI (${oauthResult.email})` 
            : `Gemini CLI Account ${accountCount + 1}`,
          accessToken: encrypt(oauthResult.accessToken),
          refreshToken: encrypt(oauthResult.refreshToken),
          expiresAt: oauthResult.expiresAt,
          email: oauthResult.email,
          projectId: oauthResult.projectId,
          tier: oauthResult.tier,
          isActive: true,
        },
      });

      revalidatePath("/dashboard/accounts");

      return {
        success: true,
        data: {
          email: oauthResult.email,
          isUpdate: false,
        },
      };
    }
  } catch (err) {
    console.error("Failed to exchange Gemini CLI OAuth code:", err);
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    return { success: false, error: errorMessage };
  }
}

/**
 * Get Codex OAuth authorization URL (browser flow)
 */
export async function getCodexAuthUrl(): Promise<ActionResult<{ authUrl: string }>> {
  const session = await auth();

  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    const state = generateCodexState();
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await generateCodeChallenge(codeVerifier);

    const cookieStore = await cookies();
    const context: CodexOAuthContext = { state, codeVerifier };
    cookieStore.set(CODEX_OAUTH_COOKIE_NAME, encrypt(JSON.stringify(context)), {
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      maxAge: 10 * 60,
      path: "/",
    });

    const params = new URLSearchParams({
      response_type: "code",
      client_id: CODEX_CLIENT_ID,
      redirect_uri: CODEX_BROWSER_REDIRECT_URI,
      scope: CODEX_OAUTH_SCOPE,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
      state,
      originator: CODEX_ORIGINATOR,
    });

    const authUrl = `${CODEX_OAUTH_AUTHORIZE_ENDPOINT}?${params.toString()}`;

    return { success: true, data: { authUrl } };
  } catch (err) {
    console.error("Failed to build Codex auth URL:", err);
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    return { success: false, error: errorMessage };
  }
}

/**
 * Exchange Codex OAuth callback URL for tokens and create/update account
 */
export async function exchangeCodexOAuthCode(
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
    let url: URL;
    try {
      url = new URL(callbackUrl);
    } catch {
      return { success: false, error: "Invalid URL format" };
    }

    const error = url.searchParams.get("error");
    if (error) {
      const message = url.searchParams.get("error_description") || error;
      return { success: false, error: `Codex OAuth error: ${message}` };
    }

    const code = url.searchParams.get("code");
    if (!code) {
      return {
        success: false,
        error: "No authorization code found in URL. Make sure you copied the complete URL from your browser.",
      };
    }

    const callbackState = url.searchParams.get("state");
    if (!callbackState) {
      return { success: false, error: "Missing OAuth state. Please restart authentication." };
    }

    const cookieStore = await cookies();
    const contextCookie = cookieStore.get(CODEX_OAUTH_COOKIE_NAME);
    if (!contextCookie?.value) {
      return { success: false, error: "Session expired. Please restart authentication." };
    }

    let oauthContext: CodexOAuthContext;
    try {
      oauthContext = JSON.parse(decrypt(contextCookie.value)) as CodexOAuthContext;
    } catch {
      cookieStore.delete(CODEX_OAUTH_COOKIE_NAME);
      return { success: false, error: "Invalid authentication state. Please restart authentication." };
    }

    if (!oauthContext.codeVerifier || !oauthContext.state) {
      cookieStore.delete(CODEX_OAUTH_COOKIE_NAME);
      return { success: false, error: "Invalid authentication context. Please restart authentication." };
    }

    if (oauthContext.state !== callbackState) {
      cookieStore.delete(CODEX_OAUTH_COOKIE_NAME);
      return { success: false, error: "Invalid OAuth state. Please restart authentication." };
    }

    const oauthResult = await codexProvider.exchangeCode(
      code,
      CODEX_BROWSER_REDIRECT_URI,
      oauthContext.codeVerifier
    );

    cookieStore.delete(CODEX_OAUTH_COOKIE_NAME);

    const chatgptAccountId = oauthResult.accountId || null;

    let existingAccount = null;
    if (chatgptAccountId) {
      existingAccount = await prisma.providerAccount.findFirst({
        where: {
          userId: session.user.id,
          provider: "codex",
          accountId: chatgptAccountId,
        },
      });
    }

    if (existingAccount) {
      await prisma.providerAccount.update({
        where: { id: existingAccount.id },
        data: {
          accessToken: encrypt(oauthResult.accessToken),
          refreshToken: encrypt(oauthResult.refreshToken),
          expiresAt: oauthResult.expiresAt,
          accountId: chatgptAccountId,
          isActive: true,
        },
      });

      revalidatePath("/dashboard/accounts");

      return {
        success: true,
        data: {
          email: existingAccount.email || `codex-${chatgptAccountId || "unknown"}`,
          isUpdate: true,
        },
      };
    }

    const accountCount = await prisma.providerAccount.count({
      where: { userId: session.user.id, provider: "codex" },
    });

    const email = chatgptAccountId
      ? `codex-${chatgptAccountId}`
      : `codex-${Date.now()}`;

    await prisma.providerAccount.create({
      data: {
        userId: session.user.id,
        provider: "codex",
        name: `Codex Account ${accountCount + 1}`,
        accessToken: encrypt(oauthResult.accessToken),
        refreshToken: encrypt(oauthResult.refreshToken),
        expiresAt: oauthResult.expiresAt,
        email,
        accountId: chatgptAccountId,
        isActive: true,
      },
    });

    revalidatePath("/dashboard/accounts");

    return {
      success: true,
      data: {
        email,
        isUpdate: false,
      },
    };
  } catch (err) {
    console.error("Failed to exchange Codex OAuth code:", err);
    const cookieStore = await cookies();
    cookieStore.delete(CODEX_OAUTH_COOKIE_NAME);
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    return { success: false, error: errorMessage };
  }
}

/**
 * Initiate Codex Device Code Flow
 * Returns device code info including URL and user code for user to enter
 */
export async function initiateCodexAuth(): Promise<
  ActionResult<{
    deviceAuthId: string;
    userCode: string;
    verificationUrl: string;
    expiresIn: number;
    interval: number;
  }>
> {
  const session = await auth();

  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    const deviceCodeInfo = await initiateCodexDeviceCodeFlow();

    // Store PKCE code verifier server-side in an encrypted HttpOnly cookie
    // keyed by deviceAuthId so it never leaves the server
    const cookieStore = await cookies();
    cookieStore.set(`codex_cv_${deviceCodeInfo.deviceAuthId}`, encrypt(deviceCodeInfo.codeVerifier), {
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      maxAge: deviceCodeInfo.expiresIn + 60, // device code TTL + buffer
      path: "/",
    });

    // Return everything except codeVerifier
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { codeVerifier: _cv, ...data } = deviceCodeInfo;

    return {
      success: true,
      data,
    };
  } catch (err) {
    console.error("Failed to initiate Codex auth:", err);
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    return { success: false, error: errorMessage };
  }
}

/**
 * Poll Codex device code authorization status
 * Call this periodically until it returns success or error
 */
export async function pollCodexAuth(
  deviceAuthId: string,
  userCode: string
): Promise<
  ActionResult<
    | { status: "pending" }
    | { status: "success"; email: string; isUpdate: boolean }
    | { status: "error"; message: string }
  >
> {
  const session = await auth();

  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    // Retrieve PKCE code verifier from server-side cookie
    const cookieStore = await cookies();
    const cvCookie = cookieStore.get(`codex_cv_${deviceAuthId}`);
    if (!cvCookie?.value) {
      return { success: false, error: "Session expired. Please restart authentication." };
    }
    const codeVerifier = decrypt(cvCookie.value);

    const result = await pollCodexDeviceCodeAuthorization(
      deviceAuthId,
      userCode,
      codeVerifier
    );

    if ("pending" in result) {
      return { success: true, data: { status: "pending" } };
    }

    if ("error" in result) {
      const errorMsg = typeof result.error === "string"
        ? result.error
        : (result.error as Record<string, unknown>)?.message as string || JSON.stringify(result.error);
      return { success: true, data: { status: "error", message: errorMsg } };
    }

    // Success - we have tokens, now save them
    const oauthResult = result;
    const chatgptAccountId = oauthResult.accountId || null;

    // Clean up the PKCE cookie
    cookieStore.delete(`codex_cv_${deviceAuthId}`);

    // Try to find existing account by accountId (stable identifier from JWT)
    // Falls back to provider-level match if no accountId available
    let existingAccount = null;
    if (chatgptAccountId) {
      existingAccount = await prisma.providerAccount.findFirst({
        where: {
          userId: session.user.id,
          provider: "codex",
          accountId: chatgptAccountId,
        },
      });
    }

    if (existingAccount) {
      // Update existing account with fresh tokens
      await prisma.providerAccount.update({
        where: { id: existingAccount.id },
        data: {
          accessToken: encrypt(oauthResult.accessToken),
          refreshToken: encrypt(oauthResult.refreshToken),
          expiresAt: oauthResult.expiresAt,
          accountId: chatgptAccountId,
          isActive: true,
        },
      });

      revalidatePath("/dashboard/accounts");

      return {
        success: true,
        data: {
          status: "success",
          email: existingAccount.email || `codex-${chatgptAccountId || "unknown"}`,
          isUpdate: true,
        },
      };
    } else {
      // Create new account
      const accountCount = await prisma.providerAccount.count({
        where: { userId: session.user.id, provider: "codex" },
      });

      const email = chatgptAccountId
        ? `codex-${chatgptAccountId}`
        : `codex-${Date.now()}`;

      await prisma.providerAccount.create({
        data: {
          userId: session.user.id,
          provider: "codex",
          name: `Codex Account ${accountCount + 1}`,
          accessToken: encrypt(oauthResult.accessToken),
          refreshToken: encrypt(oauthResult.refreshToken),
          expiresAt: oauthResult.expiresAt,
          email,
          accountId: chatgptAccountId,
          isActive: true,
        },
      });

      revalidatePath("/dashboard/accounts");

      return {
        success: true,
        data: {
          status: "success",
          email,
          isUpdate: false,
        },
      };
    }
  } catch (err) {
    console.error("Failed to poll Codex auth:", err);
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    return { success: false, error: errorMessage };
  }
}

/**
 * Set the email/identifier for a Codex account
 * Call this after successful auth to set a recognizable name
 */
export async function setCodexAccountEmail(
  accountId: string,
  email: string
): Promise<ActionResult> {
  const session = await auth();

  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    // Verify ownership
    const account = await prisma.providerAccount.findFirst({
      where: { id: accountId, userId: session.user.id, provider: "codex" },
    });

    if (!account) {
      return { success: false, error: "Account not found" };
    }

    await prisma.providerAccount.update({
      where: { id: accountId },
      data: {
        email: email.trim(),
        name: `Codex (${email.trim()})`,
      },
    });

    revalidatePath("/dashboard/accounts");

    return { success: true, data: undefined };
  } catch (error) {
    console.error("Failed to set Codex account email:", error);
    return { success: false, error: "Failed to update account" };
  }
}
