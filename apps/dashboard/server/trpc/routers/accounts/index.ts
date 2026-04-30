import { router } from "../../init";
import {
  byProviderAccountsProcedure,
  byProviderDetailedAccountsProcedure,
  createAccountProcedure,
  deleteAccountProcedure,
  errorHistoryAccountsProcedure,
  exchangeOAuthAccountProcedure,
  getAuthUrlAccountsProcedure,
  initiateDeviceAuthAccountProcedure,
  listAccountsProcedure,
  pollDeviceAuthAccountProcedure,
  resolveErrorsAccountProcedure,
  setAccountModelEnabledProcedure,
  summaryAccountsProcedure,
  togglePinnedProviderProcedure,
  updateAccountProcedure,
} from "./basic";
import { quotaAccountProcedure } from "./quota";

export const accountsRouter = router({
  list: listAccountsProcedure,
  byProvider: byProviderAccountsProcedure,
  byProviderDetailed: byProviderDetailedAccountsProcedure,
  summary: summaryAccountsProcedure,
  create: createAccountProcedure,
  update: updateAccountProcedure,
  delete: deleteAccountProcedure,
  togglePinned: togglePinnedProviderProcedure,
  setAccountModelEnabled: setAccountModelEnabledProcedure,
  errorHistory: errorHistoryAccountsProcedure,
  resolveErrors: resolveErrorsAccountProcedure,
  getAuthUrl: getAuthUrlAccountsProcedure,
  exchangeOAuth: exchangeOAuthAccountProcedure,
  initiateDeviceAuth: initiateDeviceAuthAccountProcedure,
  pollDeviceAuth: pollDeviceAuthAccountProcedure,
  quota: quotaAccountProcedure,
});
