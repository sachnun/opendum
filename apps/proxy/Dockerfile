FROM node:22-bookworm-slim AS builder
WORKDIR /app

RUN npm install -g pnpm@10.5.2

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/database/package.json ./packages/database/
COPY packages/ai/package.json ./packages/ai/
COPY apps/proxy/package.json ./apps/proxy/

RUN pnpm install --frozen-lockfile

COPY packages/database ./packages/database
COPY packages/ai ./packages/ai
COPY apps/proxy ./apps/proxy
COPY models ./models

RUN pnpm --filter @opendum/proxy build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN npm install -g pnpm@10.5.2

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/database/package.json ./packages/database/
COPY packages/ai/package.json ./packages/ai/
COPY apps/proxy/package.json ./apps/proxy/

RUN pnpm install --prod --frozen-lockfile

COPY --from=builder /app/packages/database ./packages/database
COPY --from=builder /app/packages/ai ./packages/ai
COPY --from=builder /app/apps/proxy/dist ./apps/proxy/dist
COPY models ./models

EXPOSE 8000
CMD ["node", "apps/proxy/dist/main.js"]
