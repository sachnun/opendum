import { NextRequest, NextResponse } from "next/server";
import { validateApiKey, logUsage } from "@/lib/proxy/auth";
import { getNextAccount } from "@/lib/proxy/load-balancer";
import { getValidApiKey, makeIFlowRequest } from "@/lib/proxy/iflow-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const startTime = Date.now();

  // Validate API key
  const authHeader = request.headers.get("authorization");
  const authResult = await validateApiKey(authHeader);

  if (!authResult.valid) {
    return NextResponse.json(
      { error: { message: authResult.error, type: "authentication_error" } },
      { status: 401 }
    );
  }

  const { userId, apiKeyId } = authResult;

  try {
    // Parse request body
    const body = await request.json();
    const { model, messages, stream = true, ...params } = body;

    if (!model) {
      return NextResponse.json(
        { error: { message: "model is required", type: "invalid_request_error" } },
        { status: 400 }
      );
    }

    if (!messages || !Array.isArray(messages)) {
      return NextResponse.json(
        { error: { message: "messages array is required", type: "invalid_request_error" } },
        { status: 400 }
      );
    }

    // Get next iFlow account using round-robin
    const account = await getNextAccount(userId!);

    if (!account) {
      return NextResponse.json(
        {
          error: {
            message: "No active iFlow accounts. Please add an account in the dashboard.",
            type: "configuration_error",
          },
        },
        { status: 503 }
      );
    }

    // Get valid API key (refreshes token if needed)
    const iflowApiKey = await getValidApiKey(account.id);

    // Make request to iFlow (respects stream parameter)
    const iflowResponse = await makeIFlowRequest(
      iflowApiKey,
      model,
      { messages, ...params },
      stream
    );

    // Handle errors from iFlow
    if (!iflowResponse.ok) {
      const errorText = await iflowResponse.text();
      console.error("iFlow error:", iflowResponse.status, errorText);

      // Log failed request
      await logUsage({
        userId: userId!,
        iflowAccountId: account.id,
        proxyApiKeyId: apiKeyId,
        model,
        statusCode: iflowResponse.status,
        duration: Date.now() - startTime,
      });

      return NextResponse.json(
        {
          error: {
            message: `iFlow API error: ${errorText}`,
            type: "api_error",
          },
        },
        { status: iflowResponse.status }
      );
    }

    // Log successful request
    logUsage({
      userId: userId!,
      iflowAccountId: account.id,
      proxyApiKeyId: apiKeyId,
      model,
      statusCode: 200,
      duration: Date.now() - startTime,
    });

    // Return streaming response
    if (stream) {
      const responseBody = iflowResponse.body;

      if (!responseBody) {
        return NextResponse.json(
          { error: { message: "No response body", type: "api_error" } },
          { status: 500 }
        );
      }

      return new Response(responseBody, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    // Return non-streaming response
    const responseData = await iflowResponse.json();
    return NextResponse.json(responseData);
  } catch (error) {
    console.error("Proxy error:", error);

    return NextResponse.json(
      {
        error: {
          message: error instanceof Error ? error.message : "Internal server error",
          type: "api_error",
        },
      },
      { status: 500 }
    );
  }
}
