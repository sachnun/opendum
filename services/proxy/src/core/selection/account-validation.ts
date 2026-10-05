import type { ModelValidationResult } from "@opendum/auth";
import { getCustomProvider, getForcedAccount, listCustomProviderModels } from "@opendum/database/queries";
import type { ProviderAccount } from "@opendum/providers";

import { canAccountUseModel } from "../service-accounts.ts";
import type { ProxyDeps } from "../service-deps.ts";
import { refreshAccountHealthFromModels } from "../health/service-health.ts";
import { accountAccessDenial } from "../transport/service-helpers.ts";
import type { RouteError } from "../types.ts";

export async function validateForcedAccount(
  deps: ProxyDeps,
  userId: string,
  validation: ModelValidationResult,
  forcedAccountId: string | null,
  accountAccess: { mode: string; accounts: string[] },
  allowInactive = false
): Promise<ProviderAccount | RouteError | null> {
  if (!forcedAccountId) return null;
  const id = forcedAccountId.trim();
  if (!id) {
    return {
      status: 400,
      message: "model account selector must include an account prefix",
      type: "invalid_request_error",
      param: "model",
      code: "invalid_provider_account",
    };
  }

  const synthetic = syntheticAccountFromId(deps, id, userId, validation.model);
  const denial = accountAccessDenial(id, accountAccess);
  if (denial) {
    return { status: 403, message: denial.message, type: "invalid_request_error", param: "model", code: denial.code };
  }
  if (synthetic) {
    const modelErr = await validateSelectedAccountModel(deps, synthetic, validation, "model");
    if (modelErr) return modelErr;
    return synthetic;
  }

  const row = await getForcedAccount(id, userId, deps.database);
  if (!row) {
    return {
      status: 400,
      message: "Selected provider account was not found",
      type: "invalid_request_error",
      param: "model",
      code: "provider_account_not_found",
    };
  }
  const account: ProviderAccount = {
    id: row.id,
    userId: row.userId,
    provider: row.provider,
    tier: row.tier,
    accountId: row.accountId,
    status: row.status,
    disabledUntil: row.disabledUntil,
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
    isActive: row.isActive,
  };
  const coolingDown = await refreshAccountHealthFromModels(deps, account.id, new Date());
  if (coolingDown) {
    return {
      status: 400,
      message: "Selected provider account is temporarily disabled",
      type: "invalid_request_error",
      param: "model",
      code: "provider_account_temporarily_disabled",
    };
  }
  if (!allowInactive) {
    if (!account.isActive) {
      return {
        status: 400,
        message: "Selected provider account is inactive",
        type: "invalid_request_error",
        param: "model",
        code: "provider_account_inactive",
      };
    }
    if (account.disabledUntil && account.disabledUntil.getTime() > Date.now()) {
      return {
        status: 400,
        message: "Selected provider account is temporarily disabled",
        type: "invalid_request_error",
        param: "model",
        code: "provider_account_temporarily_disabled",
      };
    }
  }
  const modelErr = await validateSelectedAccountModel(deps, account, validation, "model");
  if (modelErr) return modelErr;
  return account;
}

function syntheticAccountFromId(
  deps: ProxyDeps,
  id: string,
  userId: string,
  model: string
): ProviderAccount | null {
  if (deps.providers.isAuthless(id)) {
    return { id, userId, provider: id, isActive: true, status: "active" };
  }
  if (id.startsWith("authless:")) {
    const provider = id.slice("authless:".length);
    if (provider && deps.models.isAuthlessProviderModel(model, provider)) {
      return { id, userId, provider, isActive: true, status: "active" };
    }
  }
  return null;
}

async function isCustomAccountModel(deps: ProxyDeps, account: ProviderAccount, model: string): Promise<boolean> {
  const custom = await getCustomProvider(account.userId, account.provider, deps.database);
  if (!custom) return false;
  const rows = await listCustomProviderModels(custom.id, deps.database);
  const target = model.startsWith(`${account.provider}/`) ? model.slice(account.provider.length + 1) : model;
  return rows.some((row) => row.modelId === model || row.modelId === target);
}

async function validateSelectedAccountModel(
  deps: ProxyDeps,
  account: ProviderAccount,
  validation: ModelValidationResult,
  param: string
): Promise<RouteError | null> {
  if (await isCustomAccountModel(deps, account, validation.model)) return null;
  if (!deps.models.isSupportedByProvider(validation.model, account.provider)) {
    return {
      status: 400,
      message: `Selected account provider "${account.provider}" does not support model "${validation.model}"`,
      type: "invalid_request_error",
      param,
      code: "provider_account_model_mismatch",
    };
  }
  if (validation.provider && account.provider !== validation.provider) {
    return {
      status: 400,
      message: `Selected account provider "${account.provider}" does not match model provider "${validation.provider}"`,
      type: "invalid_request_error",
      param,
      code: "provider_account_provider_mismatch",
    };
  }
  if (!canAccountUseModel(deps, account, validation.model)) {
    return {
      status: 400,
      message: `Selected provider account tier does not allow model "${validation.model}"`,
      type: "invalid_request_error",
      param,
      code: "provider_account_tier_mismatch",
    };
  }
  return null;
}
