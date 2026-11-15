import { createSignal, type Accessor } from "solid-js";
import type { AccountQuotaInfo } from "~/lib/api-types";

const [quotaById, setQuotaById] = createSignal<Record<string, AccountQuotaInfo>>({});
const [errorById, setErrorById] = createSignal<Record<string, string>>({});
const [loadingById, setLoadingById] = createSignal<Record<string, boolean>>({});

export const quotaStore = {
  quotaById: quotaById as Accessor<Record<string, AccountQuotaInfo>>,
  errorById: errorById as Accessor<Record<string, string>>,
  loadingById: loadingById as Accessor<Record<string, boolean>>,
  setQuotaById,
  setErrorById,
  setLoadingById,
  reset(): void {
    setQuotaById({});
    setErrorById({});
    setLoadingById({});
  },
};
