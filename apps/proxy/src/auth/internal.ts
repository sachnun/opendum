import { verifyInternalSignature } from "@opendum/database";
import type { Context } from "hono";
import { config } from "../config.js";

export function validateInternalSignature(
  c: Context,
  path: string,
  rawBody: string
): boolean {
  const timestamp = c.req.header("x-opendum-internal-timestamp")?.trim();
  const signature = c.req.header("x-opendum-internal-signature")?.trim();

  if (!timestamp || !signature) {
    return false;
  }

  return verifyInternalSignature(
    config.betterAuthSecret,
    path,
    timestamp,
    signature,
    rawBody
  );
}
