import { NextRequest, NextResponse } from "next/server";
import { IFLOW_MODELS } from "@/lib/proxy/constants";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const models = Array.from(IFLOW_MODELS).map((modelId) => ({
    id: modelId,
    object: "model",
    created: Math.floor(Date.now() / 1000),
    owned_by: "iFlow",
    permission: [],
    root: modelId,
    parent: null,
  }));

  return NextResponse.json({
    object: "list",
    data: models,
  });
}
