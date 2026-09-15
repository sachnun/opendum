export type UserRole = "user" | "maintener";

const MAINTENER_ROLE: UserRole = "maintener";
const USER_ROLE: UserRole = "user";

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

export function roleForEmail(email: string | null | undefined): UserRole {
  if (!email) return USER_ROLE;

  return getMaintenerEmails().has(normalizeEmail(email)) ? MAINTENER_ROLE : USER_ROLE;
}
