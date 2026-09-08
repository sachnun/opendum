import { eq, sql } from "drizzle-orm";
import { db, providerAccount, decrypt, encrypt } from "@opendum/database";
import type { ProviderRegistry } from "@opendum/ai";

export class TokenRefresherWorker {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private providers: ProviderRegistry,
    private intervalSeconds: number
  ) {}

  start() {
    if (this.intervalSeconds <= 0) return;

    this.timer = setInterval(() => {
      this.runRefreshCycle().catch((err) => {
        console.error("Token refresher worker cycle failed:", err);
      });
    }, this.intervalSeconds * 1000);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async runRefreshCycle() {
    const oneHourFromNow = new Date(Date.now() + 60 * 60 * 1000);

    const accounts = await db
      .select()
      .from(providerAccount)
      .where(
        sql`${providerAccount.isActive} = true AND ${providerAccount.refreshToken} IS NOT NULL AND ${providerAccount.expiresAt} <= ${oneHourFromNow}`
      );

    for (const account of accounts) {
      const provider = this.providers.get(account.provider);
      if (!provider || !provider.refreshCredentials) continue;

      try {
        const rawRefreshToken = decrypt(account.refreshToken);
        const refreshed = await provider.refreshCredentials(rawRefreshToken, account);

        await db
          .update(providerAccount)
          .set({
            accessToken: encrypt(refreshed.accessToken),
            refreshToken: refreshed.refreshToken ? encrypt(refreshed.refreshToken) : account.refreshToken,
            expiresAt: refreshed.expiresAt,
            updatedAt: new Date(),
          })
          .where(eq(providerAccount.id, account.id));
      } catch (e) {
        console.warn(`Background token refresh failed for ${account.provider} (${account.id}):`, e);
      }
    }
  }
}
