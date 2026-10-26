import { eq } from "drizzle-orm";
import { Effect } from "effect";

import { db, providerAccount, type ProviderAccount } from "@opendum/database";
import { decrypt, encrypt } from "@opendum/api/web/lib/encryption";
import { fromPromise } from "@opendum/api/web/lib/task";

export type CredentialAccount = Pick<
  ProviderAccount,
  "id" | "accessToken" | "refreshToken" | "expiresAt"
>;

export type RefreshedToken = {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
};

export function tokenExpired(expiresAt: Date, bufferSeconds: number): boolean {
  return Date.now() > expiresAt.getTime() - bufferSeconds * 1000;
}

export type RefreshPlan<A extends RefreshedToken> = {
  bufferSeconds: number;
  message: string;
  refresh: (refreshToken: string) => Effect.Effect<A, unknown>;
  patch: (value: A) => Record<string, unknown>;
  tolerateFailure?: boolean;
};

export function saveTokens<A extends RefreshedToken>(
  accountId: string,
  value: A,
  patch: (value: A) => Record<string, unknown>,
  message: string
): Effect.Effect<void, unknown> {
  return fromPromise(
    () =>
      db
        .update(providerAccount)
        .set({
          accessToken: encrypt(value.accessToken),
          refreshToken: encrypt(value.refreshToken),
          expiresAt: value.expiresAt,
          ...patch(value),
        })
        .where(eq(providerAccount.id, accountId)),
    message
  );
}

export function validToken<A extends RefreshedToken>(
  account: CredentialAccount,
  plan: RefreshPlan<A>
): Effect.Effect<string, unknown> {
  const current = decrypt(account.accessToken);
  if (!tokenExpired(account.expiresAt, plan.bufferSeconds)) return Effect.succeed(current);

  const refreshed = plan.refresh(decrypt(account.refreshToken)).pipe(
    Effect.tap((value) => saveTokens(account.id, value, plan.patch, plan.message)),
    Effect.map((value) => value.accessToken)
  );
  if (!plan.tolerateFailure) return refreshed;
  return refreshed.pipe(
    Effect.catch((error) =>
      Date.now() < account.expiresAt.getTime() ? Effect.succeed(current) : Effect.fail(error)
    )
  );
}
