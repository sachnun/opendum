FROM node:22-bookworm-slim AS builder
WORKDIR /app

COPY package*.json ./
COPY packages/database/package.json ./packages/database/
COPY packages/ai/package.json ./packages/ai/
COPY apps/proxy/package.json ./apps/proxy/

RUN npm install

COPY packages/database ./packages/database
COPY packages/ai ./packages/ai
COPY apps/proxy ./apps/proxy
COPY models ./models

RUN npm run build --workspace @opendum/proxy

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
COPY packages/database/package.json ./packages/database/
COPY packages/ai/package.json ./packages/ai/
COPY apps/proxy/package.json ./apps/proxy/

RUN npm install --omit=dev

COPY --from=builder /app/packages/database ./packages/database
COPY --from=builder /app/packages/ai ./packages/ai
COPY --from=builder /app/apps/proxy/dist ./apps/proxy/dist
COPY models ./models

EXPOSE 8000
CMD ["node", "apps/proxy/dist/main.js"]
