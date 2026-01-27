import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { 
  IFLOW_OAUTH_AUTHORIZE_URL, 
  IFLOW_CLIENT_ID,
  IFLOW_REDIRECT_URI 
} from "@/lib/proxy/providers/iflow/constants";

export async function GET() {
  const session = await auth();

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Build authorization URL with iFlow-specific parameters
  const authParams = new URLSearchParams({
    loginMethod: "phone",
    type: "phone",
    redirect: IFLOW_REDIRECT_URI,
    client_id: IFLOW_CLIENT_ID,
  });

  const authUrl = `${IFLOW_OAUTH_AUTHORIZE_URL}?${authParams.toString()}`;

  // Redirect to iFlow OAuth
  return NextResponse.redirect(authUrl);
}
