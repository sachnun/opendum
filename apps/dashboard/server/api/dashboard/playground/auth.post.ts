import { createHmac } from "node:crypto";
import { createError } from "h3";
import { z } from "zod";

import { readDashboardBody, requireUserId } from "../../../utils/api";

const playgroundEndpointSchema = z.enum(["chat_completions", "messages", "responses"]);
const playgroundAuthInputSchema = z.object({
  endpoint: playgroundEndpointSchema,
}).strict();

function getEndpointPath(endpoint: z.infer<typeof playgroundEndpointSchema>) {
  if (endpoint === "messages") return "/v1/messages";
  if (endpoint === "responses") return "/v1/responses";
  return "/v1/chat/completions";
}

function signPlaygroundRequest(userId: string, timestamp: string, method: string, path: string) {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) throw createError({ statusCode: 500, statusMessage: "BETTER_AUTH_SECRET is required" });
  return createHmac("sha256", secret).update(`${userId}\n${timestamp}\n${method}\n${path}`).digest("hex");
}

export default defineEventHandler(async (event) => {
  const userId = await requireUserId(event);
  const input = await readDashboardBody(event, playgroundAuthInputSchema);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const method = "POST";
  const path = getEndpointPath(input.endpoint);

  return {
    headers: {
      "X-Opendum-Playground-User-Id": userId,
      "X-Opendum-Playground-Timestamp": timestamp,
      "X-Opendum-Playground-Signature": signPlaygroundRequest(userId, timestamp, method, path),
    },
  };
});
