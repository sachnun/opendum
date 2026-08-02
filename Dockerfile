FROM node:22-slim AS base
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/proxy/package.json apps/proxy/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci

FROM base AS build
COPY --from=deps /app/node_modules node_modules
COPY . .
RUN npm run build --workspace @opendum/api
RUN npm run build --workspace @opendum/proxy

FROM base AS runtime
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/proxy/dist apps/proxy/dist
COPY --from=build /app/models models
COPY --from=build /app/apps/api/node_modules apps/api/node_modules
COPY --from=build /app/apps/proxy/node_modules apps/proxy/node_modules
COPY --from=build /app/node_modules node_modules
CMD ["sh", "-c", "node apps/api/dist/index.js & node apps/proxy/dist/index.js"]
