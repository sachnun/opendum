import { NextResponse } from "next/server";

const PROXY_URL = process.env.NEXT_PUBLIC_PROXY_URL;

const handler = () => {
  const proxy = PROXY_URL ? ` New base URL: ${PROXY_URL}` : "";

  return NextResponse.json(
    {
      error: {
        message: `The proxy API has moved to a dedicated server. Please update your base URL.${proxy}`,
        type: "invalid_request_error",
        code: "endpoint_moved",
        ...(PROXY_URL && { proxy_url: PROXY_URL }),
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
