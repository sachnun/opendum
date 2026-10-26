import { eq } from "drizzle-orm";
import { Effect } from "effect";

import { db, providerAccount } from "@opendum/database";
import { decrypt, encrypt, hashString } from "@opendum/api/web/lib/encryption";
import { fetchExternalEffect } from "@opendum/api/web/lib/external";
import { badRequest, unavailable } from "@opendum/api/web/errors";
import { fromPromise } from "@opendum/api/web/lib/task";
import type { AuthFailure } from "@opendum/providers/auth/failure";
import type { AuthRuntime } from "@opendum/providers/auth/runtime";
import type { RefreshedToken } from "@opendum/providers/auth/credentials";

export const authRuntime: AuthRuntime = {
  fetch: (url, init) =>
    fetchExternalEffect(url, init as Parameters<typeof fetchExternalEffect>[1]).pipe(
      Effect.mapError((failure) => failure as unknown as AuthFailure)
    ),
  unavailable: (message, cause) => unavailable(message, cause) as unknown as AuthFailure,
  badRequest: (message) => badRequest(message) as unknown as AuthFailure,
  hash: hashString,
  store: {
    decrypt,
    encrypt,
    save(accountId: string, value: RefreshedToken, patch: Record<string, unknown>, message: string) {
      return fromPromise(
        () =>
          db
            .update(providerAccount)
            .set({
              accessToken: encrypt(value.accessToken),
              refreshToken: encrypt(value.refreshToken),
              expiresAt: value.expiresAt,
              ...patch,
            })
            .where(eq(providerAccount.id, accountId)),
        message
      );
    },
  },
  saveAccountId: (accountId: string, value: string) =>
    fromPromise(
      () =>
        db
          .update(providerAccount)
          .set({ accountId: value })
          .where(eq(providerAccount.id, accountId)),
      "Failed to persist account id"
    ),
};
