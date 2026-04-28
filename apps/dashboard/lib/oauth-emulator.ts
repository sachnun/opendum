import type { SocialProvider } from "./auth-client";

export function getAuthProvider(provider: SocialProvider, useOAuthEmulator: boolean) {
  if (!useOAuthEmulator) {
    return provider;
  }

  return `${provider}-emulator`;
}
