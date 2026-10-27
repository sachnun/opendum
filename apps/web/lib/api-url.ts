export function apiUrl(configured: unknown): string {
  const value = (typeof configured === "string" ? configured : "").trim().replace(/\/+$/, "");
  if (value) return value;
  return import.meta.dev ? "http://localhost:4001" : "";
}
