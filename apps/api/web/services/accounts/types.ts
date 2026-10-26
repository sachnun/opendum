export type HistoryEntry = {
  id: string;
  providerAccountId: string;
  userId: string;
  model: string | null;
  errorCode: number;
  errorMessage: string;
  createdAt: string;
  dedupeKey?: string;
};

export type AccountRow = {
  id: string;
  provider: string;
  isActive: boolean;
  disabledUntil: Date | string | null;
  status: string;
  statusChangedAt: Date | string | null;
  consecutiveErrors: number;
  lastUsedAt: Date | string | null;
  lastErrorAt: Date | string | null;
  lastErrorCode: number | null;
  lastSuccessAt: Date | string | null;
  lastRecoveredAt: Date | string | null;
};

export type HealthRow = {
  providerAccountId: string;
  status: string;
  statusChangedAt: Date | string | null;
  consecutiveErrors: number;
  lastErrorAt: Date | string | null;
  lastErrorCode: number | null;
  lastSuccessAt: Date | string | null;
  unhealthyCountUpdatedAt: Date | string | null;
};

export type AccountHealthAggregate = {
  unhealthyCount: number;
  warningCount: number;
  lastErrorAt: Date | string | null;
  lastSuccessAt: Date | string | null;
};

export interface AccountReadOptions {
  autoPin?: boolean;
}

export const AUTO_PIN_SENTINEL = "_auto_pinned";
export const IDLE_DECAY_MS = 10 * 60 * 1000;
export const MODEL_DEGRADED_THRESHOLD = 2;
export const UNHEALTHY_THRESHOLD = 10;
export const COOLDOWN_RECOVERY_RATIO = 0.3;
export const HISTORY_KEY_PREFIX = "opendum:provider-account:error-history";
export const ENTRY_KEY_PREFIX = "opendum:provider-account:error-history-entry";
