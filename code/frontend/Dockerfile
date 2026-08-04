# syntax=docker/dockerfile:1

# ---- Builder: install the workspace and build the Next.js app ----
FROM node:20-bookworm-slim AS builder
WORKDIR /app

# better-sqlite3 / bcrypt in sibling workspaces may build from source.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    NEXT_TELEMETRY_DISABLED=1

# Same reason as api/Dockerfile: the lockfile records the root `overrides` as npm 11
# resolved them, and node:20's bundled npm 10 rejects that tree as out of sync.
RUN npm install -g npm@11

COPY package.json package-lock.json ./
COPY api/package.json api/package.json
COPY frontend/package.json frontend/package.json
COPY test/package.json test/package.json
COPY extensions/sqldb/package.json extensions/sqldb/package.json
COPY extensions/contract/package.json extensions/contract/package.json
RUN npm ci

COPY . .

# NEXT_PUBLIC_* values are inlined into the client bundle at build time. Leave
# them empty by default so the frontend derives the API host from the address
# the visitor loaded the page from (see frontend/app/utils/config.ts). Only set
# them to pin a specific host (e.g. an internet-facing tunnel URL).
ARG NEXT_PUBLIC_API_BASE_URL=
ARG NEXT_PUBLIC_WS_BASE_URL=
# Which sign-in the login form drives: `center` (the default, forwards to Center) or
# `local` (Network Intel's own password + emailed one-time code). It has to be a build
# arg like the two above: .dockerignore excludes **/.env.*, so frontend/.env.local never
# reaches the image, and without this the containerised login page silently falls back to
# Center — which fails at the first submit on any stack that has no CENTER_PLAYME_URL.
ARG NEXT_PUBLIC_AUTH_MODE=
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL \
    NEXT_PUBLIC_WS_BASE_URL=$NEXT_PUBLIC_WS_BASE_URL \
    NEXT_PUBLIC_AUTH_MODE=$NEXT_PUBLIC_AUTH_MODE

WORKDIR /app/frontend
RUN npm run build

# ---- Runtime ----
FROM node:20-bookworm-slim AS runtime
WORKDIR /app/frontend

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000

COPY --from=builder /app/node_modules /app/node_modules
COPY --from=builder /app/package.json /app/package.json
COPY --from=builder /app/frontend /app/frontend

USER node
EXPOSE 3000
CMD ["npm", "run", "start"]
