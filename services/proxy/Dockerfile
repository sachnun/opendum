FROM node:24-bookworm-slim

RUN corepack enable

WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages ./packages
COPY services ./services
COPY apps/dashboard/package.json ./apps/dashboard/package.json

RUN pnpm install --frozen-lockfile --filter @opendum/proxy...

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8000

EXPOSE 8000

CMD ["pnpm", "--filter", "@opendum/proxy", "start"]
