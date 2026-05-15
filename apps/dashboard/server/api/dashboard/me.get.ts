import { getDashboardRoleForEmail } from "../../utils/maintainers";
import { requireSession } from "../../utils/session";

export default defineEventHandler(async (event) => {
  const session = await requireSession(event);
  const role = getDashboardRoleForEmail(session.user.email);

  return {
    role,
    isMaintener: role === "maintener",
  };
});
