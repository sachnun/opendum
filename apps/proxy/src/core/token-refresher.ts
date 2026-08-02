import type { ProxyDB } from "../db/index.js";
import type Redis from "ioredis";
import type { Registry } from "../registry/index.js";
import { decrypt } from "../crypto/index.js";
import type { Provider, HttpClient } from "../providers/types.js";
import { refreshBufferFor } from "../providers/providers.js";
import { and, eq, lte, or, sql, isNull } from "drizzle-orm";
import { schema } from "../db/index.js";
import { encrypt } from "../crypto/index.js";
import { newID } from "../db/id.js";
import type { ProviderAccountLike, RefreshedCredentials } from "../providers/types.js";
import type { RequestContext } from "../providers/types.js";

const tokenRefreshLockPrefix = "opendum:provider-account:refresh-lock:";
const tokenRefreshLockTTL = 2 * 60 * 1000;
const tokenRefreshWaitTimeout = 3 * 1000;
const tokenRefreshWaitInterval = 250;
const tokenRefreshAccountTimeout = 90 * 1000;
const tokenRefreshBatchLimit = 500;

export interface TokenRefresherDeps {
  db: ProxyDB | null;
  redis: Redis | null;
  registry: Registry;
  secret: string;
  client: HttpClient;
  getProvider: (name: string) => Provider | undefined;
  refreshableProviderNames: () => string[];
}

export class TokenRefresher {
  constructor(private deps: TokenRefresherDeps) {}

  async refreshExpiringTokens(): Promise<void> {
    if (!this.deps.db) return;
    const accounts = await this.expiringRefreshableAccounts();
    await Promise.all(accounts.map((account) => this.refreshOne(account)));
  }

  private async refreshOne(account: ProviderAccountLike): Promise<void> {
    const providerImpl = this.deps.getProvider(account.provider);
    if (!providerImpl) return;
    try {
      const [, , didRefresh] = await this.refreshAccountCredentialsIfDue(account, providerImpl, false);
      if (didRefresh) {
        // refreshed
      }
    } catch {
      // ignore individual failures
    }
  }

  async expiringRefreshableAccounts(): Promise<ProviderAccountLike[]> {
    if (!this.deps.db) return [];
    const names = this.deps.refreshableProviderNames();
    if (names.length === 0) return [];
    const now = new Date();
    const accounts: ProviderAccountLike[] = [];
    for (const name of names) {
      const providerImpl = this.deps.getProvider(name);
      if (!providerImpl) continue;
      const buffer = refreshBufferFor(providerImpl);
      if (buffer <= 0) continue;
      const rows = await this.deps.db
        .select({
          id: schema.providerAccount.id,
          userId: schema.providerAccount.userId,
          provider: schema.providerAccount.provider,
          name: schema.providerAccount.name,
          accessToken: schema.providerAccount.accessToken,
          refreshToken: schema.providerAccount.refreshToken,
          expiresAt: schema.providerAccount.expiresAt,
          apiKey: schema.providerAccount.apiKey,
          projectId: schema.providerAccount.projectId,
          tier: schema.providerAccount.tier,
          accountId: schema.providerAccount.accountId,
          email: schema.providerAccount.email,
          isActive: schema.providerAccount.isActive,
          disabledUntil: schema.providerAccount.disabledUntil,
          lastUsedAt: schema.providerAccount.lastUsedAt,
          status: schema.providerAccount.status,
        })
        .from(schema.providerAccount)
        .where(
          and(
            or(isNull(schema.providerAccount.disabledUntil), lte(schema.providerAccount.disabledUntil, now)),
            eq(schema.providerAccount.provider, name),
            sql`${schema.providerAccount.refreshToken} <> ''`,
            lte(schema.providerAccount.expiresAt, new Date(now.getTime() + buffer)),
          ),
        )
        .orderBy(sql`"isActive" DESC, "expiresAt" ASC`)
        .limit(tokenRefreshBatchLimit);
      accounts.push(...(rows as unknown as ProviderAccountLike[]));
    }
    return accounts;
  }

  async credentialsForAccount(account: ProviderAccountLike, providerImpl: Provider): Promise<[string, ProviderAccountLike, Error | null]> {
    const requestAccount = await this.loadProviderAccountCredentials(account);
    let credentials = "";
    try {
      credentials = decrypt(this.deps.secret, requestAccount.accessToken);
    } catch (error) {
      return ["", requestAccount, error as Error];
    }

    const [refreshedCredentials, refreshedAccount, , err] = await this.refreshAccountCredentialsIfDue(requestAccount, providerImpl, true);
    if (err) {
      if (requestAccount.expiresAt.getTime() < Date.now()) {
        return ["", requestAccount, err];
      }
      return [credentials, requestAccount, null];
    }
    if (refreshedCredentials !== "") {
      return [refreshedCredentials, refreshedAccount, null];
    }
    return [credentials, requestAccount, null];
  }

  async refreshAccountCredentialsIfDue(account: ProviderAccountLike, providerImpl: Provider, waitForLock: boolean): Promise<[string, ProviderAccountLike, boolean, Error | null]> {
    const refresher = providerImpl as unknown as { refreshCredentials?: (ctx: RequestContext, client: HttpClient, refreshToken: string, account: ProviderAccountLike) => Promise<RefreshedCredentials> };
    if (typeof refresher.refreshCredentials !== "function" || !accountNeedsCredentialRefresh(account, providerImpl)) {
      return ["", account, false, null];
    }
    if (account.refreshToken === "") {
      if (waitForLock && account.expiresAt.getTime() < Date.now()) {
        return ["", account, false, new Error("provider account token has expired and cannot be refreshed")];
      }
      return ["", account, false, null];
    }
    let refreshToken = "";
    try {
      refreshToken = decrypt(this.deps.secret, account.refreshToken);
    } catch (error) {
      return ["", account, false, error as Error];
    }
    if (refreshToken.trim() === "") {
      if (waitForLock && account.expiresAt.getTime() < Date.now()) {
        return ["", account, false, new Error("provider account token has expired and cannot be refreshed")];
      }
      return ["", account, false, null];
    }

    const lockValue = await this.acquireRefreshLock(account.id);
    if (lockValue === "") {
      if (waitForLock && account.expiresAt.getTime() < Date.now()) {
        const [credentials, updatedAccount, err] = await this.waitForRefreshedAccount(account);
        return [credentials, updatedAccount, false, err];
      }
      return ["", account, false, null];
    }
    try {
      const current = await this.loadProviderAccountCredentialsByID(account.id);
      if (!accountNeedsCredentialRefresh(current, providerImpl)) {
        let credentials = "";
        try {
          credentials = decrypt(this.deps.secret, current.accessToken);
        } catch (error) {
          return ["", current, false, error as Error];
        }
        return [credentials, current, false, null];
      }
      if (current.refreshToken === "") {
        if (waitForLock && current.expiresAt.getTime() < Date.now()) {
          return ["", current, false, new Error("provider account token has expired and cannot be refreshed")];
        }
        return ["", current, false, null];
      }
      let currentRefreshToken = "";
      try {
        currentRefreshToken = decrypt(this.deps.secret, current.refreshToken);
      } catch (error) {
        return ["", current, false, error as Error];
      }
      if (currentRefreshToken.trim() === "") {
        if (waitForLock && current.expiresAt.getTime() < Date.now()) {
          return ["", current, false, new Error("provider account token has expired and cannot be refreshed")];
        }
        return ["", current, false, null];
      }
      let refreshed: RefreshedCredentials;
      try {
        refreshed = await refresher.refreshCredentials({}, this.deps.client, currentRefreshToken, current);
      } catch (error) {
        return ["", current, false, error as Error];
      }
      const updatedAccount = await this.persistRefreshedCredentials(current, refreshed);
      return [refreshed.accessToken, updatedAccount, true, null];
    } finally {
      await this.releaseRefreshLock(account.id, lockValue);
    }
  }

  async loadProviderAccountCredentials(account: ProviderAccountLike): Promise<ProviderAccountLike> {
    if (account.accessToken !== "" && account.refreshToken !== "") return account;
    return this.loadProviderAccountCredentialsByID(account.id);
  }

  async loadProviderAccountCredentialsByID(accountID: string): Promise<ProviderAccountLike> {
    if (!this.deps.db) {
      throw new Error("no db");
    }
    const rows = await this.deps.db
      .select({
        id: schema.providerAccount.id,
        userId: schema.providerAccount.userId,
        provider: schema.providerAccount.provider,
        name: schema.providerAccount.name,
        accessToken: schema.providerAccount.accessToken,
        refreshToken: schema.providerAccount.refreshToken,
        expiresAt: schema.providerAccount.expiresAt,
        apiKey: schema.providerAccount.apiKey,
        projectId: schema.providerAccount.projectId,
        tier: schema.providerAccount.tier,
        accountId: schema.providerAccount.accountId,
        email: schema.providerAccount.email,
        isActive: schema.providerAccount.isActive,
        disabledUntil: schema.providerAccount.disabledUntil,
        lastUsedAt: schema.providerAccount.lastUsedAt,
        status: schema.providerAccount.status,
      })
      .from(schema.providerAccount)
      .where(eq(schema.providerAccount.id, accountID))
      .limit(1);
    if (rows.length === 0) throw new Error("account not found");
    return rows[0] as unknown as ProviderAccountLike;
  }

  async persistRefreshedCredentials(account: ProviderAccountLike, refreshed: RefreshedCredentials): Promise<ProviderAccountLike> {
    if (!this.deps.db) return account;
    if (refreshed.accessToken === "" || refreshed.refreshToken === "" || refreshed.expiresAt.getTime() === 0) {
      throw new Error("provider token refresh returned incomplete credentials");
    }
    let storeAccessToken = refreshed.accessToken;
    if (refreshed.storeAccessToken.trim() !== "") {
      storeAccessToken = refreshed.storeAccessToken;
    }
    const encryptedAccess = encrypt(this.deps.secret, storeAccessToken);
    const encryptedRefresh = encrypt(this.deps.secret, refreshed.refreshToken);
    const now = new Date();

    const patch: Record<string, unknown> = {
      accessToken: encryptedAccess,
      refreshToken: encryptedRefresh,
      expiresAt: refreshed.expiresAt,
      updatedAt: now,
    };
    if (refreshed.projectId !== "") patch["projectId"] = refreshed.projectId;
    if (refreshed.tier !== "") patch["tier"] = refreshed.tier;
    if (refreshed.email !== "") patch["email"] = refreshed.email;
    if (refreshed.accountId !== "") patch["accountId"] = refreshed.accountId;

    await this.deps.db.update(schema.providerAccount).set(patch as never).where(eq(schema.providerAccount.id, account.id));

    return {
      ...account,
      accessToken: encryptedAccess,
      refreshToken: encryptedRefresh,
      expiresAt: refreshed.expiresAt,
      projectId: refreshed.projectId !== "" ? refreshed.projectId : account.projectId,
      tier: refreshed.tier !== "" ? refreshed.tier : account.tier,
      email: refreshed.email !== "" ? refreshed.email : account.email,
      accountId: refreshed.accountId !== "" ? refreshed.accountId : account.accountId,
    };
  }

  async acquireRefreshLock(accountID: string): Promise<string> {
    if (!this.deps.redis) return newID();
    const value = newID();
    try {
      const acquired = await this.deps.redis.set(tokenRefreshLockKey(accountID), value, "PX", tokenRefreshLockTTL, "NX");
      return acquired === "OK" ? value : "";
    } catch {
      return "";
    }
  }

  async releaseRefreshLock(accountID: string, value: string): Promise<void> {
    if (!this.deps.redis || value === "") return;
    try {
      const lua = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;
      await this.deps.redis.eval(lua, 1, tokenRefreshLockKey(accountID), value);
    } catch {
      // ignore
    }
  }

  async waitForRefreshedAccount(previous: ProviderAccountLike): Promise<[string, ProviderAccountLike, Error | null]> {
    const deadline = Date.now() + tokenRefreshWaitTimeout;
    while (Date.now() < deadline) {
      await sleep(tokenRefreshWaitInterval);
      try {
        const current = await this.loadProviderAccountCredentialsByID(previous.id);
        if (current.expiresAt.getTime() > Date.now() && current.expiresAt.getTime() > previous.expiresAt.getTime()) {
          const credentials = decrypt(this.deps.secret, current.accessToken);
          return [credentials, current, null];
        }
      } catch {
        // continue polling
      }
    }
    return ["", previous, new Error("provider account token refresh is already in progress")];
  }
}

function accountNeedsCredentialRefresh(account: ProviderAccountLike, providerImpl: Provider): boolean {
  return Date.now() > account.expiresAt.getTime() - refreshBufferFor(providerImpl);
}

function tokenRefreshLockKey(accountID: string): string {
  return tokenRefreshLockPrefix + accountID;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
