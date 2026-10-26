import { Effect } from "effect";

export type CredentialAccount = {
  id: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
};

export type RefreshedToken = {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
};

export type RefreshPlan<A extends RefreshedToken> = {
  bufferSeconds: number;
  message: string;
  refresh: (refreshToken: string) => Effect.Effect<A, unknown>;
  patch: (value: A) => Record<string, unknown>;
  tolerateFailure?: boolean;
};

export interface CredentialStore {
  decrypt(value: string): string;
  encrypt(value: string): string;
  save(accountId: string, value: RefreshedToken, patch: Record<string, unknown>, message: string): Effect.Effect<void, unknown>;
}

export function tokenExpired(expiresAt: Date, bufferSeconds: number): boolean {
  return Date.now() > expiresAt.getTime() - bufferSeconds * 1000;
}

export function validToken<A extends RefreshedToken>(
  account: CredentialAccount,
  plan: RefreshPlan<A>,
  store: CredentialStore
): Effect.Effect<string, unknown> {
  const current = store.decrypt(account.accessToken);
  if (!tokenExpired(account.expiresAt, plan.bufferSeconds)) return Effect.succeed(current);

  const refreshed = plan.refresh(store.decrypt(account.refreshToken)).pipe(
    Effect.tap((value) => store.save(account.id, value, plan.patch(value), plan.message)),
    Effect.map((value) => value.accessToken)
  );
  if (!plan.tolerateFailure) return refreshed;
  return refreshed.pipe(
    Effect.catch((error) =>
      Date.now() < account.expiresAt.getTime() ? Effect.succeed(current) : Effect.fail(error)
    )
  );
}
