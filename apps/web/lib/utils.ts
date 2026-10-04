import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function requestErrorMessage(error: unknown, fallback = "Request failed. Please try again."): string {
  if (error && typeof error === "object") {
    const candidate = error as {
      data?: { statusMessage?: string; message?: string };
      statusMessage?: string;
      message?: string;
    };
    return candidate.data?.statusMessage ?? candidate.data?.message ?? candidate.statusMessage ?? candidate.message ?? fallback;
  }
  return fallback;
}

export function avatarUrl(url: string, size = 64) {
  if (url.includes("avatars.githubusercontent.com")) {
    const parsed = new URL(url);
    parsed.searchParams.set("s", String(size));
    return parsed.toString();
  }

  if (url.includes("googleusercontent.com")) {
    return /=s\d+(-c)?/.test(url) ? url.replace(/=s\d+(-c)?/, `=s${size}-c`) : `${url}=s${size}-c`;
  }

  return url;
}
