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
RUN npm ci

# Application source (node_modules is excluded via .dockerignore).
COPY . .

# ---- Runtime: slim image without the build toolchain ----
FROM node:20-bookworm-slim AS runtime
WORKDIR /app/api

ENV NODE_ENV=production \
    ENVIRONMENT=TEST \
    PORT=8080 \
    DATABASE_FILE=/data/database.sqlite \
    UPLOAD_DIR=/data/uploads

# Hoisted dependencies, the API source, and the TypeScript-only workspace
# package the API imports as source (@extensions/sqldb). The node_modules
# symlink to it is preserved by COPY.
COPY --from=builder /app/node_modules /app/node_modules
COPY --from=builder /app/package.json /app/package.json
COPY --from=builder /app/extensions /app/extensions
COPY --from=builder /app/api /app/api

# /data holds the SQLite file and uploads; it is backed by a volume at runtime.
RUN mkdir -p /data && chown node:node /data
USER node

EXPOSE 8080
# Run via tsx (transpile on the fly): the sqldb extension is consumed as TS
# source, so there is no compiled dist to `node` directly.
CMD ["/app/node_modules/.bin/tsx", "src/server.ts"]
