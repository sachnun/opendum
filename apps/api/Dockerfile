FROM oven/bun:1.4.4-alpine

WORKDIR /app

COPY apps/api/.output ./.output
COPY packages/models/data ./packages/models/data
COPY packages/models/generated ./packages/models/generated

ENV NODE_ENV=production
ENV PORT=8000

EXPOSE 8000

CMD ["bun", "--smol", ".output/server/index.mjs"]
