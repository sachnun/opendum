import { z } from "zod";

import { listModels } from "../../../services/models";
import { getDashboardQuery, requireReadableUserId } from "../../../utils/api";

const modelsQuerySchema = z.object({
  includeStats: z.union([z.literal("true"), z.literal("false"), z.boolean()]).optional(),
});

import type { Context } from "hono";
export async function handler(c: Context) {

  const query = getDashboardQuery(c, modelsQuerySchema);
  return listModels(await requireReadableUserId(c), { includeStats: query.includeStats !== "false" && query.includeStats !== false });

}

import { Hono } from "hono";

const app = new Hono();
app.get("/", async (c) => c.json(await handler(c)));
export default app;
