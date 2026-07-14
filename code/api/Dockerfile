# syntax=docker/dockerfile:1

# ---- Builder: install the whole workspace (incl. native modules) ----
FROM node:20-bookworm-slim AS builder
WORKDIR /app

# Toolchain for native modules (better-sqlite3). Lives only in this stage.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

# The `test` workspace depends on Playwright; don't pull its browsers here.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Copy every workspace manifest first so `npm ci` can build the exact tree the
# lockfile describes, and so this layer caches across source-only changes.
COPY package.json package-lock.json ./
COPY api/package.json api/package.json
COPY frontend/package.json frontend/package.json
COPY test/package.json test/package.json
COPY extensions/sqldb/package.json extensions/sqldb/package.json
COPY extensions/contract/package.json extensions/contract/package.json
RUN npm ci

# Application source (node_modules is excluded via .dockerignore).
COPY . .

# ---- Runtime: slim image without the build toolchain ----
FROM node:20-bookworm-slim AS runtime
WORKDIR /app/api

ENV NODE_ENV=production \
    DB_ENGINE=postgres \
    PORT=4000 \
    UPLOAD_DIR=/data/uploads
# DATABASE_URL is supplied at runtime (docker-compose / deploy env), not baked in.

# Hoisted dependencies, the API source, and the TypeScript-only workspace
# package the API imports as source (@extensions/sqldb). The node_modules
# symlink to it is preserved by COPY.
COPY --from=builder /app/node_modules /app/node_modules
COPY --from=builder /app/package.json /app/package.json
COPY --from=builder /app/extensions /app/extensions
COPY --from=builder /app/api /app/api

# /data holds uploaded files (temporary); it is backed by a volume at runtime.
RUN mkdir -p /data && chown node:node /data
USER node

EXPOSE 4000
# Run via tsx (transpile on the fly): the sqldb/contract extensions are consumed
# as TS source, so there is no compiled dist to `node` directly. Migrate first
# (idempotent), then exec the server so it receives SIGTERM for graceful shutdown.
CMD ["sh", "-c", "/app/node_modules/.bin/tsx src/migrate.ts && exec /app/node_modules/.bin/tsx src/server.ts"]
