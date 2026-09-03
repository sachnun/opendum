import { connectCustomProviderAccount, connectCustomProviderAccountSchema } from "../../../services/custom-providers";
import { readDashboardBody, requireWritableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => {
  const input = await readDashboardBody(event, connectCustomProviderAccountSchema);
  return connectCustomProviderAccount(await requireWritableUserId(event), input.slug, input.token, input.name);
});
