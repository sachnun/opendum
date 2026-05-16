import { getAccountAuthUrl, getAuthUrlInputSchema } from "../../../../services/account-auth";
import { readDashboardBody, requireUserId } from "../../../../utils/api";

export default defineEventHandler(async (event) => {
  await requireUserId(event);
  return getAccountAuthUrl(await readDashboardBody(event, getAuthUrlInputSchema));
});
