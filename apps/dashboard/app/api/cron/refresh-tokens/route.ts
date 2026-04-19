import { NextResponse } from "next/server";
import { refreshTokens } from "@opendum/shared/cron/refresh-tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // Allow up to 60 seconds for processing

export async function GET() {
  try {
    return NextResponse.json(await refreshTokens());
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Cron refresh job failed:", errorMessage);

    return NextResponse.json(
      {
        success: false,
        error: errorMessage,
        duration: 0,
      },
      { status: 500 },
    );
  }
}
