import { createServer, serve } from "@emulators/core";
import { githubPlugin, seedFromConfig as seedGithub } from "@emulators/github";
import { googlePlugin, seedFromConfig as seedGoogle } from "@emulators/google";

const GITHUB_PORT = Number(process.env.GITHUB_EMULATOR_PORT ?? 4001);
const GOOGLE_PORT = Number(process.env.GOOGLE_EMULATOR_PORT ?? 4002);

function startService({ plugin, seedFromConfig, port, config, fallbackUser }) {
  const baseUrl = `http://localhost:${port}`;
  const { app, store } = createServer(plugin, { port, baseUrl, fallbackUser });

  plugin.seed?.(store, baseUrl);
  seedFromConfig?.(store, baseUrl, config);

  return { baseUrl, server: serve({ fetch: app.fetch, port }) };
}

const github = startService({
  plugin: githubPlugin,
  seedFromConfig: seedGithub,
  port: GITHUB_PORT,
  fallbackUser: { login: "opendum-dev", id: 1, scopes: [] },
  config: {
    users: [{ login: "opendum-dev", name: "Opendum Dev", email: "dev@opendum.local" }],
  },
});

const google = startService({
  plugin: googlePlugin,
  seedFromConfig: seedGoogle,
  port: GOOGLE_PORT,
  fallbackUser: { login: "dev@opendum.local", id: 1, scopes: ["openid", "email", "profile"] },
  config: {
    users: [{ email: "dev@opendum.local", name: "Opendum Dev", email_verified: true }],
  },
});

console.log(`GitHub OAuth emulator: ${github.baseUrl}`);
console.log(`Google OAuth emulator: ${google.baseUrl}`);
console.log("Start the dashboard with AUTH_OAUTH_EMULATOR=1 to sign in against these emulators.");

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    github.server.close();
    google.server.close();
    process.exit(0);
  });
}
