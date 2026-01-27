import { NextResponse } from "next/server";
import { formatModelsForOpenAI } from "@/lib/proxy/models";

export const runtime = "nodejs";

export async function GET() {
  const models = formatModelsForOpenAI().map((model) => ({
    ...model,
    permission: [],
    root: model.id,
    parent: null,
  }));

  return NextResponse.json({
    object: "list",
    data: models,
  });
}
