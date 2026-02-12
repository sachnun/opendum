import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDisabledModelSetForUser, validateApiKey } from "@/lib/proxy/auth";
import { formatModelsForOpenAI, resolveModelAlias } from "@/lib/proxy/models";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const authHeader =
    request.headers.get("authorization") ?? request.headers.get("x-api-key");

  let userId: string | null = null;
  let apiKeyModelAccessMode: "all" | "whitelist" | "blacklist" = "all";
  let apiKeyModelSet = new Set<string>();

  if (authHeader) {
    const authResult = await validateApiKey(authHeader);

    if (!authResult.valid) {
      return NextResponse.json(
        { error: { message: authResult.error, type: "authentication_error" } },
        { status: 401 }
      );
    }

    userId = authResult.userId ?? null;
    apiKeyModelAccessMode = authResult.modelAccessMode ?? "all";
    apiKeyModelSet = new Set(
      (authResult.modelAccessList ?? []).map((model) => resolveModelAlias(model))
    );
  } else {
    const session = await auth();
    userId = session?.user?.id ?? null;
  }

  const allModelsWithAliases = formatModelsForOpenAI();
  const canonicalModels = new Map<
    string,
    {
      id: string;
      object: string;
      created: number;
      owned_by: string;
    }
  >();

  for (const model of allModelsWithAliases) {
    const canonicalId = resolveModelAlias(model.id);

    if (canonicalModels.has(canonicalId)) {
      continue;
    }

    canonicalModels.set(canonicalId, {
      ...model,
      id: canonicalId,
    });
  }

  const allModels = Array.from(canonicalModels.values());

  if (!userId) {
    return NextResponse.json({
      object: "list",
      data: allModels,
    });
  }

  const disabledModelSet = await getDisabledModelSetForUser(userId);
  const enabledModels = allModels.filter((model) => {
    const canonicalModel = resolveModelAlias(model.id);

    if (disabledModelSet.has(canonicalModel)) {
      return false;
    }

    if (apiKeyModelAccessMode === "whitelist") {
      return apiKeyModelSet.has(canonicalModel);
    }

    if (apiKeyModelAccessMode === "blacklist") {
      return !apiKeyModelSet.has(canonicalModel);
    }

    return true;
  });

  return NextResponse.json({
    object: "list",
    data: enabledModels,
  });
}
