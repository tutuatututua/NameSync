# Authentication

NameSync ships as a **single-user internal tool**, so it uses a deliberately minimal model.

## Today: auth-lite

- All history/session data is owned by one hardcoded `DEFAULT_USER_ID`
  (`api/src/config/constants.ts`). Ownership checks exist but are effectively no-ops.
- There is **no login UI** and no JWT verification.
- The **callback** endpoint and the **destructive `/all`** endpoints are guarded by a
  shared secret: send it as the `X-Callback-Token` header, matched against `CALLBACK_TOKEN`.
  If `CALLBACK_TOKEN` is unset (typical in local dev) the guard is a no-op, so the app stays
  easy to run — set a strong value in production. See `api/src/lib/auth.ts`.

## Upgrade path (multi-user)

To make this multi-tenant:

1. Add real authentication (JWT or session cookies) as a Fastify plugin / `preHandler`
   that resolves the request's `userId`.
2. Replace `DEFAULT_USER_ID` usages with the authenticated user; the ownership checks in
   the history routes then become real.
3. Scope `company_data` / `facebook_data` (currently global, cumulative tables) per user or
   per workspace if isolation is required — see the dedupe/merge notes in `docs/DB.md`.

The unused `extensions/auth-guard` / `extensions/cookie-auth` scaffolds are a starting point.
