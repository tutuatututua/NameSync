# Project Overview

Monorepo `fx-generated` — see `README.md` for full details.

# Layout
- `api/` — Fastify v5 + TypeScript API on PostgreSQL (Kysely). OpenAPI at `/docs`.
- `frontend/` — Next.js 15 + React 19, shadcn/ui + Tailwind, TanStack Query.
- `extensions/` — shared workspace packages (`contract`, `sqldb`, ...).
- `test/` — Playwright E2E.

# Dependencies
## `api/`
- @extensions/contract@^1.0.0 (shared Zod schemas/types)
- @extensions/sqldb@^1.0.0 (Kysely pool)
- fastify@^5, fastify-type-provider-zod@^4, zod@^3
- @fastify/cors, @fastify/multipart, @fastify/websocket, @fastify/swagger, @fastify/swagger-ui
- kysely@^0.27, pg@^8, exceljs@^4 (.xlsx uploads; .csv/.json are read by hand in `src/lib/`), dotenv@^16, ws@^8
- dev: vitest, tsx, form-data, pino-pretty, typescript@^5

## `frontend/`
- next@^15, react@^19, react-dom@^19
- @tanstack/react-query@^5, zod@^3, @extensions/contract
- shadcn/ui deps: @radix-ui/*, class-variance-authority, clsx, tailwind-merge, lucide-react
- next-themes, sonner, framer-motion
- tailwindcss@^3 (+ tailwindcss-animate, @tailwindcss/forms)

# Installed Extensions
## `contract` — shared API/WS Zod contract
## `sqldb` — Kysely connection pools (Postgres for the app)
## `auth-guard` / `cookie-auth` — scaffolds for the multi-user upgrade (see docs/AUTH.md)
