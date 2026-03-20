import { NextResponse } from "next/server";

const handler = () =>
  NextResponse.json(
    {
      error: {
        message:
          "The proxy API has moved to a dedicated server. Please update your base URL to the new proxy endpoint.",
        type: "invalid_request_error",
        code: "endpoint_moved",
      },
    },
    { status: 410 },
  );

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const DELETE = handler;
export const PATCH = handler;
