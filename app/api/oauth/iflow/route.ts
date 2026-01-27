import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { IFLOW_OAUTH_AUTHORIZE_URL, IFLOW_CLIENT_ID } from "@/lib/proxy/constants";

// iFlow OAuth callback port (fixed by iFlow)
const IFLOW_CALLBACK_PORT = "11451";

export async function GET() {
  const session = await auth();

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // iFlow requires callback to localhost:11451/oauth2callback
  const callbackUrl = `http://localhost:${IFLOW_CALLBACK_PORT}/oauth2callback`;

  // Build authorization URL with iFlow-specific parameters
  const authParams = new URLSearchParams({
    loginMethod: "phone",
    type: "phone",
    redirect: callbackUrl,
    client_id: IFLOW_CLIENT_ID,
  });

  const authUrl = `${IFLOW_OAUTH_AUTHORIZE_URL}?${authParams.toString()}`;

  // Redirect to iFlow OAuth
  return NextResponse.redirect(authUrl);
}
