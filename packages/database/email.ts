export function normalizeEmail(email: string): string {
  const trimmed = email.trim().toLowerCase();
  const separator = trimmed.lastIndexOf("@");
  if (separator <= 0) return trimmed;

  const local = trimmed.slice(0, separator).split("+")[0];
  return `${local}@${trimmed.slice(separator + 1)}`;
}
