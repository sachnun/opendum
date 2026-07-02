export type DashboardUserRole = "user" | "maintener";

const MAINTENER_ROLE: DashboardUserRole = "maintener";
const USER_ROLE: DashboardUserRole = "user";

let hasWarnedInvalidMaintainers = false;

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

function warnInvalidMaintainers() {
  if (hasWarnedInvalidMaintainers) return;

  console.warn("MAINTENERS must be a JSON array of email strings. Ignoring invalid value.");
  hasWarnedInvalidMaintainers = true;
}

function getMaintenerEmails(): Set<string> {
  const rawValue = process.env.MAINTENERS?.trim();

  if (!rawValue) {
    return new Set();
  }

  try {
    const parsedValue = JSON.parse(rawValue) as unknown;

    if (!Array.isArray(parsedValue)) {
      warnInvalidMaintainers();
      return new Set();
    }

    return new Set(parsedValue.flatMap((value) => {
      if (typeof value !== "string") return [];

      const email = normalizeEmail(value);
      return email ? [email] : [];
    }));
  } catch {
    warnInvalidMaintainers();
    return new Set();
  }
}

export function getDashboardRoleForEmail(email: string | null | undefined): DashboardUserRole {
  if (!email) return USER_ROLE;

  return getMaintenerEmails().has(normalizeEmail(email)) ? MAINTENER_ROLE : USER_ROLE;
}

function isMaintenerEmail(email: string | null | undefined): boolean {
  return getDashboardRoleForEmail(email) === MAINTENER_ROLE;
}
