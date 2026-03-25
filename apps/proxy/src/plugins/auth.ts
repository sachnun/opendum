import type { FastifyRequest, FastifyReply } from "fastify";
import {
  validateApiKey,
  type ApiKeyModelAccessMode,
  type ApiKeyAccountAccessMode,
} from "@opendum/shared";

export interface AuthenticatedUser {
  userId: string;
  apiKeyId?: string;
  modelAccessMode: ApiKeyModelAccessMode;
  modelAccessList: string[];
  accountAccessMode: ApiKeyAccountAccessMode;
  accountAccessList: string[];
}

/**
 * Authenticate a request via API key (Bearer token or X-Api-Key header).
 * Returns the authenticated user info or sends an error response.
 */
export async function authenticateRequest(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<AuthenticatedUser | null> {
  const authHeader =
    (request.headers.authorization as string | undefined) ??
    (request.headers["x-api-key"] as string | undefined) ??
    null;

  if (!authHeader) {
    reply.code(401).send({
      error: {
        message: "Missing Authorization header. Use Bearer <api-key> or X-Api-Key header.",
        type: "authentication_error",
      },
    });
    return null;
  }

  const authResult = await validateApiKey(authHeader);

  if (!authResult.valid) {
    reply.code(401).send({
      error: {
        message: authResult.error,
        type: "authentication_error",
      },
    });
    return null;
  }

  return {
    userId: authResult.userId!,
    apiKeyId: authResult.apiKeyId,
    modelAccessMode: authResult.modelAccessMode ?? "all",
    modelAccessList: authResult.modelAccessList ?? [],
    accountAccessMode: authResult.accountAccessMode ?? "all",
    accountAccessList: authResult.accountAccessList ?? [],
  };
}
