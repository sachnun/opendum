// Cron job to proactively refresh OAuth tokens before they expire
// Schedule: Daily at 00:00 UTC (configured in vercel.json)
// Note: On-demand token refresh is handled by each provider, so this is just proactive refresh

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { encrypt, decrypt } from "@/lib/encryption";
import { getProvider, isValidProvider } from "@/lib/proxy/providers/registry";
import { OAUTH_PROVIDER_NAMES, type ProviderNameType } from "@/lib/proxy/providers/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // Allow up to 60 seconds for processing

// Refresh tokens that expire within this threshold (default: 2 hours)
const REFRESH_THRESHOLD_SECONDS = parseInt(
  process.env.TOKEN_REFRESH_THRESHOLD_SECONDS || "7200",
  10
);

interface RefreshResult {
  accountId: string;
  provider: string;
  email: string | null;
  status: "refreshed" | "failed" | "skipped";
  error?: string;
}

export async function GET() {
  const startTime = Date.now();
  const results: RefreshResult[] = [];

  try {
    // Get all active provider accounts
    const accounts = await prisma.providerAccount.findMany({
      where: {
        isActive: true,
        provider: { in: OAUTH_PROVIDER_NAMES },
      },
      select: {
        id: true,
        provider: true,
        email: true,
        refreshToken: true,
        accessToken: true,
        expiresAt: true,
        apiKey: true,
        projectId: true,
        tier: true,
      },
    });

    // Calculate threshold time
    const thresholdTime = new Date(
      Date.now() + REFRESH_THRESHOLD_SECONDS * 1000
    );

    for (const account of accounts) {
      // Skip if token doesn't expire within threshold
      if (account.expiresAt > thresholdTime) {
        results.push({
          accountId: account.id,
          provider: account.provider,
          email: account.email,
          status: "skipped",
        });
        continue;
      }

      // Validate provider
      if (!isValidProvider(account.provider)) {
        results.push({
          accountId: account.id,
          provider: account.provider,
          email: account.email,
          status: "failed",
          error: `Unknown provider: ${account.provider}`,
        });
        continue;
      }

      try {
        // Get provider instance
        const provider = await getProvider(account.provider as ProviderNameType);

        // Decrypt current refresh token
        const refreshTokenValue = decrypt(account.refreshToken);

        // Call provider's refresh token method
        const newTokens = await provider.refreshToken(refreshTokenValue);

        // Prepare update data
        const updateData: {
          accessToken: string;
          refreshToken: string;
          expiresAt: Date;
          email?: string;
          apiKey?: string;
          projectId?: string;
          tier?: string;
        } = {
          accessToken: encrypt(newTokens.accessToken),
          refreshToken: encrypt(newTokens.refreshToken),
          expiresAt: newTokens.expiresAt,
        };

        // Update optional fields if present in response
        if (newTokens.email) {
          updateData.email = newTokens.email;
        }
        if (newTokens.apiKey) {
          updateData.apiKey = encrypt(newTokens.apiKey);
        }
        if (newTokens.projectId) {
          updateData.projectId = newTokens.projectId;
        }
        if (newTokens.tier) {
          updateData.tier = newTokens.tier;
        }

        // Update database
        await prisma.providerAccount.update({
          where: { id: account.id },
          data: updateData,
        });

        results.push({
          accountId: account.id,
          provider: account.provider,
          email: account.email,
          status: "refreshed",
        });
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);

        results.push({
          accountId: account.id,
          provider: account.provider,
          email: account.email,
          status: "failed",
          error: errorMessage,
        });
      }
    }

    // Calculate summary
    const summary = {
      total: results.length,
      refreshed: results.filter((r) => r.status === "refreshed").length,
      failed: results.filter((r) => r.status === "failed").length,
      skipped: results.filter((r) => r.status === "skipped").length,
      duration: Date.now() - startTime,
    };

    return NextResponse.json({
      success: true,
      summary,
      results,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Cron refresh job failed:", errorMessage);

    return NextResponse.json(
      {
        success: false,
        error: errorMessage,
        duration: Date.now() - startTime,
      },
      { status: 500 }
    );
  }
}
