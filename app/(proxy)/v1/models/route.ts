import { NextResponse } from "next/server";
import { formatModelsForOpenAI } from "@/lib/proxy/models";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({
    object: "list",
    data: formatModelsForOpenAI(),
  });
}
