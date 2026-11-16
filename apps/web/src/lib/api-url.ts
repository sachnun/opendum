export function apiUrl(configured: unknown): string {
  const value = (typeof configured === "string" ? configured : "").trim().replace(/\/+$/, "");
  if (!value) throw new Error("VITE_API is required");
  return value;
}
