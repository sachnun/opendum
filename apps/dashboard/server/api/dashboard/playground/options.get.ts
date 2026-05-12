import { getPlaygroundOptions } from "../../../services/playground";
import { requireUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event);
  return getPlaygroundOptions(await requireUserId(event), config.proxyUrl || config.public.proxyUrl);
});
