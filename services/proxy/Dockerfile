FROM oven/bun:1-alpine

WORKDIR /app

COPY dist ./dist
COPY packages/models/data ./packages/models/data
COPY packages/models/generated ./packages/models/generated

ENV NODE_ENV=production

EXPOSE 8000

CMD ["bun", "--smol", "dist/main.js"]
