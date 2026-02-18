import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { maintenanceMode } from "@/lib/flags";

export async function middleware(request: NextRequest) {
  const isMaintenance = await maintenanceMode();

  if (!isMaintenance) {
    return NextResponse.next();
  }

  const { pathname } = request.nextUrl;

  // Allow the maintenance page itself through to avoid rewrite loop
  if (pathname === "/maintenance") {
    return NextResponse.next();
  }

  // API routes: return 503 JSON
  if (pathname.startsWith("/v1/")) {
    return NextResponse.json(
      {
        error: {
          message:
            "Service is currently under maintenance. Please try again later.",
          type: "server_error",
          code: "maintenance_mode",
        },
      },
      { status: 503, headers: { "Retry-After": "300" } },
    );
  }

  // Web routes: rewrite to maintenance page (preserves original URL)
  const url = request.nextUrl.clone();
  url.pathname = "/maintenance";
  return NextResponse.rewrite(url);
}

export const config = {
  matcher: ["/", "/dashboard/:path*", "/v1/:path*"],
};
