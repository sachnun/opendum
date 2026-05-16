import { getPlaygroundOptions } from "../../../services/playground";
import { requireReadableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event);
  return getPlaygroundOptions(await requireReadableUserId(event), config.proxyUrl || config.public.proxyUrl);
});
