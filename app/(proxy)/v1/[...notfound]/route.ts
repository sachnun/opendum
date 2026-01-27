import { NextResponse } from "next/server";

export const runtime = "nodejs";

const notFoundResponse = () =>
  NextResponse.json(
    { error: { message: "Unknown API endpoint", type: "invalid_request_error" } },
    { status: 404 }
  );

export const GET = notFoundResponse;
export const POST = notFoundResponse;
export const PUT = notFoundResponse;
export const DELETE = notFoundResponse;
export const PATCH = notFoundResponse;
