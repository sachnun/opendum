import type { RedisClientType } from "redis";
import type { ModelRegistry } from "@opendum/ai";
export interface ValidateApiKeyResult {
    valid: boolean;
    error?: string;
    userId?: string;
    apiKeyId?: string;
    modelAccessMode?: string;
    modelAccessList?: string[];
    accountAccessMode?: string;
    accountAccessList?: string[];
    roamingEnabled?: boolean;
}
export interface AccountModelAvailability {
    ownedAccountsByProvider: Map<string, string[]>;
    sharedAccountsByProvider: Map<string, string[]>;
    ownedDisabledModelsByAccount: Map<string, Set<string>>;
    sharedDisabledModelsByAccount: Map<string, Set<string>>;
}
export declare class AuthService {
    private redis;
    private registry;
    constructor(redis: RedisClientType, registry: ModelRegistry);
    validateAPIKey(authHeader: string): Promise<ValidateApiKeyResult>;
    disabledModelSetForUser(userId: string): Promise<Set<string>>;
    getAccountModelAvailabilityWithSharing(userId: string, roamingEnabled: boolean): Promise<AccountModelAvailability>;
    isModelUsableByAccounts(model: string, availability: AccountModelAvailability): boolean;
    isModelUsableBySharedAccounts(model: string, availability: AccountModelAvailability): boolean;
}
//# sourceMappingURL=service.d.ts.map