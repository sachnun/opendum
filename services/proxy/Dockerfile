FROM oven/bun:1-alpine

WORKDIR /app

COPY dist ./dist
COPY packages/models/data ./packages/models/data

ENV NODE_ENV=production

EXPOSE 8000

CMD ["bun", "--smol", "dist/main.js"]
