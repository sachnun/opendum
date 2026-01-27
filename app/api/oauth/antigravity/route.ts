import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  ANTIGRAVITY_CLIENT_ID,
  ANTIGRAVITY_SCOPES,
  ANTIGRAVITY_REDIRECT_URI,
} from "@/lib/proxy/providers/antigravity/constants";

export const runtime = "nodejs";

/**
 * Initiate Antigravity (Google) OAuth flow
 * Redirects to Google OAuth with localhost callback (user will copy URL)
 */
export async function GET() {
  // Check if user is authenticated
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Build Google OAuth URL with localhost redirect
  const params = new URLSearchParams({
    client_id: ANTIGRAVITY_CLIENT_ID,
    redirect_uri: ANTIGRAVITY_REDIRECT_URI,
    response_type: "code",
    scope: ANTIGRAVITY_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
  });

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;

  return NextResponse.redirect(authUrl);
}
