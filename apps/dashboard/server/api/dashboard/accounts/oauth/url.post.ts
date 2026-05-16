import { getAccountAuthUrl, getAuthUrlInputSchema } from "../../../../services/account-auth";
import { readDashboardBody, requireWritableUserId } from "../../../../utils/api";

export default defineEventHandler(async (event) => {
  await requireWritableUserId(event);
  return getAccountAuthUrl(await readDashboardBody(event, getAuthUrlInputSchema));
});
