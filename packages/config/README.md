# @opendum/config

Environment parsing and validation shared by every runtime.

## API

- `envSchema` - Zod schema for all supported environment variables.
- `loadEnv(source?)` - validate and return a typed `Env`; throws `ConfigError`.
- `loadEnvFile(path?)` - load a `.env` file when present.

## Commands

| Command | Description |
| --- | --- |
| `pnpm test` | Unit tests |
| `pnpm typecheck` | `tsc --noEmit` |
