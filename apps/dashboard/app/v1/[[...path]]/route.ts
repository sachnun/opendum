import { NextResponse } from "next/server";

const PROXY_URL = process.env.NEXT_PUBLIC_PROXY_URL;

const handler = () => {
  const proxyBaseUrl = PROXY_URL ? PROXY_URL.replace(/\/$/, "") + "/v1" : "";
  const proxy = proxyBaseUrl ? ` New base URL: ${proxyBaseUrl}` : "";

  return NextResponse.json(
    {
      error: {
        message: `The proxy API has moved to a dedicated server. Please update your base URL.${proxy}`,
        type: "invalid_request_error",
        code: "endpoint_moved",
        ...(proxyBaseUrl && { proxy_url: proxyBaseUrl }),
      },
    },
    { status: 410 },
  );
};

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const DELETE = handler;
export const PATCH = handler;
