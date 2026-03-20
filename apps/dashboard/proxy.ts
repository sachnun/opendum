import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { maintenanceMode } from "@/lib/flags";

export async function proxy(request: NextRequest) {
  const isMaintenance = await maintenanceMode();

  if (!isMaintenance) {
    return NextResponse.next();
  }

  const { pathname } = request.nextUrl;

  // Allow the maintenance page itself through to avoid rewrite loop
  if (pathname === "/maintenance") {
    return NextResponse.next();
  }

  // Web routes: rewrite to maintenance page (preserves original URL)
  const url = request.nextUrl.clone();
  url.pathname = "/maintenance";
  return NextResponse.rewrite(url);
}

export const config = {
  matcher: ["/", "/dashboard/:path*"],
};
