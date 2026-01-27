import { NextResponse } from "next/server";

export const runtime = "nodejs";

const jsonErrorResponse = () =>
  NextResponse.json(
    {
      error: {
        message: "Please use a specific endpoint like /v1/chat/completions or /v1/messages",
        type: "invalid_request_error",
      },
    },
    { status: 404 }
  );

// GET request (browser) -> redirect to dashboard
export const GET = () => NextResponse.redirect(new URL("/dashboard", process.env.NEXTAUTH_URL || "http://localhost:3000"));

// Other methods -> JSON error
export const POST = jsonErrorResponse;
export const PUT = jsonErrorResponse;
export const DELETE = jsonErrorResponse;
export const PATCH = jsonErrorResponse;
