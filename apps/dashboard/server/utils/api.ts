import type { H3Event } from "h3";
import { createError, getQuery, readBody } from "h3";
import { z, ZodError } from "zod";

import { requireSession } from "./session";

export type ActionResult<T = void> =
  | { success: true; data: T }
  | { success: false; error: string };

export async function requireUserId(event: H3Event): Promise<string> {
  const session = await requireSession(event);
  return session.user.id;
}

function badRequestFromZod(error: ZodError): never {
  const message = error.issues[0]?.message ?? "Invalid request";
  throw createError({ statusCode: 400, statusMessage: message });
}

export async function readDashboardBody<TSchema extends z.ZodType>(
  event: H3Event,
  schema: TSchema
): Promise<z.output<TSchema>> {
  try {
    return schema.parse(await readBody(event));
  } catch (error) {
    if (error instanceof ZodError) badRequestFromZod(error);
    throw error;
  }
}

export function getDashboardQuery<TSchema extends z.ZodType>(
  event: H3Event,
  schema: TSchema
): z.output<TSchema> {
  try {
    return schema.parse(getQuery(event));
  } catch (error) {
    if (error instanceof ZodError) badRequestFromZod(error);
    throw error;
  }
}
