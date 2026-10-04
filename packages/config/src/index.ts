import { z } from "zod";

export const envSchema = z.object({
  HOST: z.string().min(1).default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(4001),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  BETTER_AUTH_SECRET: z.string().min(1),
  MODELS_DIR: z.string().min(1).optional(),
  UNROXY_URL: z.string().min(1).default("http://127.0.0.1:8080"),
  PSIPHON_REGION: z.string().min(1).default("US"),
  REQUEST_TIMEOUT_SECONDS: z.coerce.number().int().nonnegative().default(90),
  TOKEN_REFRESH_INTERVAL_SECONDS: z.coerce.number().int().nonnegative().default(600),
});

export type Env = z.infer<typeof envSchema>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new ConfigError(`invalid environment: ${issues}`);
  }
  return result.data;
}

export function loadEnvFile(path = ".env"): void {
  try {
    process.loadEnvFile(path);
  } catch {
    return;
  }
}
