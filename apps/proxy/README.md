# Opendum Go Proxy

Go implementation of the Opendum proxy runtime.

The current implementation covers:

- API key authentication against the existing PostgreSQL schema
- Redis-backed API key and account rate limiting
- TOML model registry loading from `packages/models`
- `/v1/models`
- `/v1/chat/completions`
- `/v1/responses`
- `/v1/messages` with basic Anthropic/OpenAI transforms
- API-key providers: OpenRouter, Groq, Cerebras, NVIDIA NIM, Ollama Cloud, Kilo Code, Workers AI

OAuth providers still need full parity ports before this replaces the TypeScript proxy:

- Antigravity
- Copilot
- Qwen Code
- Gemini CLI
- Codex
- Kiro

## Development

```sh
go run ./cmd/proxy
```

Required environment variables:

- `DATABASE_URL`
- `REDIS_URL`
- `BETTER_AUTH_SECRET`

Optional:

- `PORT`, defaults to `4001`
- `HOST`, defaults to `0.0.0.0`
- `MODELS_DIR`, auto-detected in normal repo layouts
