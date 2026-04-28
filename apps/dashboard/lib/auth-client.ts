import { createAuthClient } from "better-auth/vue";
import { genericOAuthClient } from "better-auth/client/plugins";

export type SocialProvider = "github" | "google";

export const authClient = createAuthClient({
  plugins: [genericOAuthClient()],
});
export const { signIn, signOut, useSession } = authClient;
