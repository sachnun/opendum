export type SocialProvider = "github" | "google";

export function authProvider(provider: SocialProvider, useOAuthEmulator: boolean) {
  return useOAuthEmulator ? `${provider}-emulator` : provider;
}
