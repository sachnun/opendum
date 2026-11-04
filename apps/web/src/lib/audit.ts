import { createSignal } from "solid-js";
import type { AuditInfo, MeData } from "~/lib/api-types";
import { dataKeys } from "~/lib/data-keys";
import { refreshQueries, queryEntry } from "~/lib/query";
import { quotaStore } from "~/lib/quota-store";

const emptyAuditInfo: AuditInfo = {
  active: false,
  readonly: false,
  user: null,
};

const [auditRefreshVersion, setAuditRefreshVersion] = createSignal(0);
const [me, setMe] = createSignal<MeData | null>(null);

export const auditState = { auditRefreshVersion, me, setMe };

export function syncMeFromQuery(): void {
  const entry = queryEntry<MeData>(dataKeys.me);
  if (!entry) return;
  setMe(entry.data() ?? null);
}

export function audit(): AuditInfo {
  return me()?.audit ?? emptyAuditInfo;
}

export function isAuditMode(): boolean {
  const info = audit();
  return info.active && Boolean(info.user);
}

export function auditUser() {
  return audit().user;
}

export async function refreshAfterAudit(): Promise<void> {
  setAuditRefreshVersion((version) => version + 1);
  quotaStore.reset();
  await refreshQueries([dataKeys.me]);
  syncMeFromQuery();
}
