import { NextRequest, NextResponse } from "next/server";
import { IFLOW_MODELS } from "@/lib/proxy/constants";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  // Return available models in OpenAI format
  const models = IFLOW_MODELS.map((modelId) => ({
    id: `iflow/${modelId}`,
    object: "model",
    created: Math.floor(Date.now() / 1000),
    owned_by: "iflow",
    permission: [],
    root: modelId,
    parent: null,
  }));

  return NextResponse.json({
    object: "list",
    data: models,
  });
}
