import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { validateModel } from "@/lib/proxy/auth";
import { getNextAccount } from "@/lib/proxy/load-balancer";
import { getProvider } from "@/lib/proxy/providers";
import type { ProviderNameType } from "@/lib/proxy/providers/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Playground chat endpoint
 * Uses session authentication instead of API key
 * Model format: "model" (auto) or "provider/model" (specific provider)
 */
export async function POST(request: NextRequest) {
  // Auth via session (not API key)
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: { message: "Unauthorized", type: "authentication_error" } },
      { status: 401 }
    );
  }

  try {
    // Parse request body
    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: { message: "Invalid JSON in request body", type: "invalid_request_error" } },
        { status: 400 }
      );
    }

    const { model: modelParam, messages, stream = false, ...params } = body;

    if (!modelParam) {
      return NextResponse.json(
        { error: { message: "model is required", type: "invalid_request_error" } },
        { status: 400 }
      );
    }

    // Validate model - supports both "model" and "provider/model" formats
    const modelValidation = validateModel(modelParam);
    if (!modelValidation.valid) {
      return NextResponse.json(
        {
          error: {
            message: modelValidation.error,
            type: "invalid_request_error",
            param: modelValidation.param,
            code: modelValidation.code,
          },
        },
        { status: 400 }
      );
    }

    const { provider, model } = modelValidation;

    if (!messages || !Array.isArray(messages)) {
      return NextResponse.json(
        { error: { message: "messages array is required", type: "invalid_request_error" } },
        { status: 400 }
      );
    }

    // Get next account using round-robin
    // If provider is specified, only use that provider's accounts
    const account = await getNextAccount(session.user.id, model, provider);

    if (!account) {
      const errorMsg = provider
        ? `No active accounts available for provider "${provider}". Please add a ${provider} account.`
        : `No active accounts available for model "${model}". Please add a provider account that supports this model.`;
      
      return NextResponse.json(
        {
          error: {
            message: errorMsg,
            type: "configuration_error",
          },
        },
        { status: 503 }
      );
    }

    // Get the provider implementation
    const providerImpl = await getProvider(account.provider as ProviderNameType);

    // Get valid credentials (handles token refresh if needed)
    const credentials = await providerImpl.getValidCredentials(account);

    // Make request to provider's API
    const providerResponse = await providerImpl.makeRequest(
      credentials,
      account,
      { model, messages, stream, ...params },
      stream
    );

    // Handle errors from provider
    if (!providerResponse.ok) {
      const errorText = await providerResponse.text();

      return NextResponse.json(
        {
          error: {
            message: `${account.provider} API error: ${errorText}`,
            type: "api_error",
          },
        },
        { status: providerResponse.status }
      );
    }

    // Streaming response
    if (stream) {
      const responseBody = providerResponse.body;

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
          "X-Accel-Buffering": "no",
        },
      });
    }

    // Non-streaming response
    const responseData = await providerResponse.json();
    return NextResponse.json(responseData);
  } catch (error) {
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
