import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { validateApiKey } from "@/lib/proxy/auth";
import { formatModelsForOpenAI, resolveModelAlias } from "@/lib/proxy/models";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const authHeader =
    request.headers.get("authorization") ?? request.headers.get("x-api-key");

  let userId: string | null = null;

  if (authHeader) {
    const authResult = await validateApiKey(authHeader);

    if (!authResult.valid) {
      return NextResponse.json(
        { error: { message: authResult.error, type: "authentication_error" } },
        { status: 401 }
      );
    }

    userId = authResult.userId ?? null;
  } else {
    const session = await auth();
    userId = session?.user?.id ?? null;
  }

  const allModels = formatModelsForOpenAI();

  if (!userId) {
    return NextResponse.json({
      object: "list",
      data: allModels,
    });
  }

  const disabledModels = await prisma.disabledModel.findMany({
    where: { userId },
    select: { model: true },
  });

  const disabledModelSet = new Set(
    disabledModels.map((entry: { model: string }) => entry.model)
  );
  const enabledModels = allModels.filter(
    (model) => !disabledModelSet.has(resolveModelAlias(model.id))
  );

  return NextResponse.json({
    object: "list",
    data: enabledModels,
  });
}
