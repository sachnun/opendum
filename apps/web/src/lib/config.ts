import { apiUrl } from "~/lib/api-url";

export function baseApiUrl(): string {
  return apiUrl(import.meta.env.VITE_API_URL);
}
