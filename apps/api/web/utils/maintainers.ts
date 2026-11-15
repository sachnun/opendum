import { parseJson } from "@opendum/platform/json";
export type UserRole = "user" | "maintainer";

const MAINTAINER_ROLE: UserRole = "maintainer";
const USER_ROLE: UserRole = "user";

const warningState = { warned: false };

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

function warnInvalid() {
  if (warningState.warned) return;

  console.warn("MAINTAINERS must be a JSON array of email strings. Ignoring invalid value.");
  warningState.warned = true;
}

function maintainerEmails(): Set<string> {
  const rawValue = process.env.MAINTAINERS?.trim();

  if (!rawValue) {
    return new Set();
  }

  const parsedValue = parseJson(rawValue) as unknown;

  if (!Array.isArray(parsedValue)) {
    warnInvalid();
    return new Set();
  }

  return new Set(parsedValue.flatMap((value) => {
    if (typeof value !== "string") return [];

    const email = normalizeEmail(value);
    return email ? [email] : [];
  }));
}

export function roleOf(email: string | null | undefined): UserRole {
  if (!email) return USER_ROLE;

  return maintainerEmails().has(normalizeEmail(email)) ? MAINTAINER_ROLE : USER_ROLE;
}
