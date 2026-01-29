FROM oven/bun:1.1.20

WORKDIR /app

COPY package.json bun.lock tsconfig.json vite.config.ts index.html ./
COPY src ./src

RUN bun install --frozen-lockfile
RUN bun run build

ENV NODE_ENV=production

EXPOSE 51234

CMD ["bun", "run", "start", "--", "--project", "/project", "--port", "51234"]
