export {
  AuthenticationFailure,
  ConfigurationFailure,
  InsufficientPointsFailure,
  InternalFailure,
  NoAccountsFailure,
  RateLimitFailure,
  UpstreamFailure,
  ValidationFailure,
  type ProxyFailure,
} from "@opendum/api/proxy/errors/failures";
export { FailureMap } from "@opendum/api/proxy/errors/failure-map";
export { ProviderError } from "@opendum/api/proxy/errors/provider";
export { Workbuddy } from "@opendum/api/proxy/errors/workbuddy";
export { ProviderQuota } from "@opendum/api/proxy/errors/quota";
export { AccountError, type AccountErrorContext } from "@opendum/api/proxy/errors/account";
