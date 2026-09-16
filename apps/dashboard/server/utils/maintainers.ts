export type UserRole = "user" | "maintainer";

const MAINTAINER_ROLE: UserRole = "maintainer";
const USER_ROLE: UserRole = "user";

let hasWarnedInvalidMaintainers = false;

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

function warnInvalidMaintainers() {
  if (hasWarnedInvalidMaintainers) return;

  console.warn("MAINTAINERS must be a JSON array of email strings. Ignoring invalid value.");
  hasWarnedInvalidMaintainers = true;
}

function getMaintainerEmails(): Set<string> {
  const rawValue = process.env.MAINTAINERS?.trim();

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

  return getMaintainerEmails().has(normalizeEmail(email)) ? MAINTAINER_ROLE : USER_ROLE;
}
