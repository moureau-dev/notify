# syntax=docker/dockerfile:1

FROM oven/bun:1 AS build
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
RUN bun build src/index.ts --outdir dist --target bun

FROM oven/bun:1-slim
WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATABASE_PATH=/data/notify.sqlite

RUN groupadd --system notify \
    && useradd --system --gid notify --home-dir /app --shell /usr/sbin/nologin notify \
    && mkdir -p /data \
    && chown -R notify:notify /app /data

COPY --from=build /app/dist ./dist
COPY --from=build /app/src/db/migrations ./dist/migrations
COPY public ./public
COPY package.json ./

USER notify

EXPOSE 8787
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["bun", "-e", "const r = await fetch('http://127.0.0.1:8787/healthz'); process.exit(r.ok ? 0 : 1)"]

CMD ["bun", "run", "dist/index.js", "serve"]
