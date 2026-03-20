FROM node:22-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

FROM base AS build
WORKDIR /app

# Copy workspace config
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/proxy/package.json apps/proxy/

# Install all dependencies
RUN pnpm install --frozen-lockfile

# Copy source code
COPY packages/shared/ packages/shared/
COPY apps/proxy/ apps/proxy/

# Build shared package then proxy
RUN pnpm --filter @opendum/shared build
RUN pnpm --filter @opendum/proxy build

# Prune dev dependencies
RUN pnpm --filter @opendum/proxy deploy --prod /app/pruned

FROM base AS production
WORKDIR /app

# Copy built output and production dependencies
COPY --from=build /app/pruned/ ./
COPY --from=build /app/packages/shared/dist/ ./node_modules/@opendum/shared/dist/
COPY --from=build /app/packages/shared/models/ ./node_modules/@opendum/shared/models/
COPY --from=build /app/packages/shared/package.json ./node_modules/@opendum/shared/

ENV NODE_ENV=production
EXPOSE 4000

CMD ["node", "dist/server.js"]
