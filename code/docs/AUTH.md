# Authentication

**Center (centerapp.io) is the only way in.** It owns the password and any second factor;
Network Intel owns *who is allowed in and with what role*. A sign-in succeeds only when both
agree - Center accepts the credentials, and an `app_user` row already exists for that email.

There is no auto-provisioning: Center accepting your whole company's credentials does not put
anyone into Network Intel that an admin has not first added.

> **A local password path existed until 2026-08-04 and was deleted.** `POST /api/auth/login`
> and `POST /api/auth/otp/login` minted a full session from `app_user.password_hash` without
> consulting Center. Both were public and guarded only by `NODE_ENV` - and the compose stack
> runs `development` deliberately (see `docker-compose.override.yml`), so configuring Center
> did **not** close them. Switching the login form to Center only changed which endpoint the
> *form* called; a plain `curl` to `/api/auth/login` still returned an admin session on a
> LAN-reachable host. They were deleted rather than flagged off, because a second door held
> shut by a flag gets reopened for a demo and left that way.

## The shape of it

| | |
| --- | --- |
| **Who you are** | Center. It verifies the password and any second factor. |
| **Whether you may in** | `app_user` - a row must exist and be active. This is also where roles live. |
| **Sessions** | `auth_session`. A 32-byte random token; the table stores only its SHA-256. |
| **Transport** | An `httpOnly` cookie (`networkintel_session`), set by `POST /api/auth/center/login`. |
| **The guard** | A global `onRequest` hook - `api/src/plugins/auth.ts`. Authentication *and* roles. |

Center's own token is read once (to fetch the profile) and thrown away. Network Intel mints
its **own** session, for two reasons worth stating plainly:

**A session is a row, so it can be revoked.** Signing out or disabling an account takes effect
on the *next request*. A JWT cannot do this - it is a signed claim the server can only verify,
so a stolen one stays valid until it expires, and "sign out" is a lie the client tells itself.

**The token is `httpOnly`, so script cannot read it.** Nothing in the frontend is ever given
it - the browser attaches the cookie by itself (`credentials: "include"`).

**`app_user.password_hash` still exists and is never read.** The column is `NOT NULL`, so
account creation writes 32 random bytes nobody has ever seen. If you are wondering whether it
can still sign someone in: no, nothing reads it.

## Creating the first account

There is **no public sign-up**, deliberately: Network Intel is an internal tool, and an open
`/register` would put the data behind nothing at all. So the first account is made from the
command line, and it must be an admin — otherwise no one can create the second one.

```bash
cd code/api
npm run create-user -- you@example.com --name "Your Name" --admin
```

Further accounts take a role — see [Roles](#roles) for what each one gets:

```bash
npm run create-user -- them@example.com              # `user`  — the whole app
npm run create-user -- them@example.com --reviewer   # read-only Network page
```

**No password.** Center holds the credential; a row here only says which Center identity is
allowed in, and with what role. Creating an account here does **not** create a Center account —
the person must already be able to sign in to Center with that exact email, or they will be
turned away with "your Center account isn't authorised for Network Intel".

> **The script reads `code/api/.env`, which may not be the database your stack is running
> against.** The compose stack takes `DATABASE_URL` from `code/.env`. If the two differ, the
> account lands in the wrong database and the person simply cannot sign in, with no error to
> explain why. Check both, and override on the command line when they disagree:
> `DATABASE_URL="…" DB_SCHEMA=lakeshore npm run create-user -- …`

This needs `app_user` / `auth_session` to exist already — they are created by
`docs/schema-redesign.sql` along with the rest of the schema (see [DB.md](DB.md)), or by
`docs/add-auth.sql` if you are adding auth to a database that predates it.

After that, an admin creates users through the API (`POST /api/auth/users`).

Passwords are Center's business now, so this app has no password rules at all.

## Endpoints

| Route | Auth | |
| --- | --- | --- |
| `POST /api/auth/center/login` | public | Forward to Center. The only way to obtain a session. Two steps when Center wants a second factor - see below. |
| `POST /api/auth/logout` | any | Deletes the session row. Always clears the cookie. |
| `GET /api/auth/me` | session | The signed-in user. **401 when signed out** - this is how the frontend asks. |
| `POST /api/auth/users` | **admin** | Authorise a Center identity. No password field. |

`POST /api/auth/login`, `/api/auth/otp/login` and `/api/auth/change-password` are **gone** (404).
A password is changed in Center.

The token is returned **only** as a `Set-Cookie`, never in a response body — so it stays out
of logs, out of browser history, and out of reach of script.

`Authorization: Bearer <token>` is also accepted, for scripts and tests that read the token
off the `Set-Cookie` themselves. It is the same opaque session token, looked up the same way;
there is no second code path.

## Two-factor

Center owns the second factor entirely - Network Intel relays it and never mints a code.
`POST /api/auth/center/login` is one endpoint, two calls (`api/src/services/center-auth.service.ts`):

1. `{email, password}` -> forwarded to Center. If Center wants a second factor it answers with
   an *error* naming the method, which becomes a challenge `{twoFactorRequired, method, ref}`
   and **no cookie**. For `email` and `sms`, Network Intel also calls Center's `sendcode` so
   the code is actually delivered.
2. `{email, password, code, method, ref}` -> the same call again with the answer. On success
   the session cookie is set.

The password is re-sent on step two because the proxy is **stateless** - nothing half-finished
is held between the calls, exactly as Center's own client works.

Three methods are relayed: `totp` (authenticator app), `email`, and `sms`. An expired Center
password (`requiredReset`) is refused with a "reset it in Center" message rather than a
session - Network Intel cannot change a Center password.

## What's protected

Everything, via the global hook. The exceptions, all deliberate:

- `POST /api/auth/center/login` — where a session comes from, and now the only public auth route.
- `/api/health` — so a load balancer can probe the app.
- `/docs` — the OpenAPI UI.
- `/api/callbacks/*` — the external matcher posting results back. Machine-to-machine, with no
  user to sign in as, so it keeps its own shared secret (`X-Callback-Token`, matched against
  `CALLBACK_TOKEN`; see `api/src/lib/auth.ts`). **Set `CALLBACK_TOKEN` in production** — when
  it's unset the check is a no-op.
- `/ws` — the websocket handshake.

> **`/ws` is a known gap.** It is open, and it emits comparison-progress events to anyone who
> connects. Unlike the old JWT (which a browser cannot attach as a header to a WebSocket), the
> session cookie *is* sent on the handshake — so guarding it is now possible, and should be
> done. It was left alone here because closing it is a behaviour change that deserves its own
> commit rather than being smuggled into this one.

## Roles

Signing in answers *who you are*. Roles answer *what you may call*. Both are decided on the same
`onRequest` hook, so a route added later cannot forget the second one.

| Role | What it gets |
| --- | --- |
| `admin` | Everything, plus creating accounts (`POST /api/auth/users`). |
| `user` | Everything except creating accounts. |
| `reviewer` | The Network workspace, **read only**. No imports, no matcher runs, no edits, and no Uploads or Data page. |

An account holding none of these is refused everything. That is deliberate — a typo'd or emptied
`roles` array should lock the account out rather than fall through to full access.

**The reviewer allowlist lives in `api/src/lib/roles.ts`,** and it is an explicit list of
method + path rather than a rule like "reviewers may only send `GET`". Two reasons, both real:

- Not every read is a `GET`. `POST /api/db/sql` and `POST /api/db/tables/:table/query` are reads
  with a body — a method rule would hand a reviewer the SQL console.
- Not every `GET` is theirs. `GET /api/db/tables` and `GET /api/upload-sessions` are the Data and
  Uploads pages, which a reviewer should not reach at all.

So a **new route is denied to reviewers until someone adds it to that list on purpose.** If a
reviewer reports a page that won't load, that list is the first place to look.

The frontend has a mirror of this in `frontend/lib/auth/access.ts` (which pages may be opened) and
`usePermissions()` in `frontend/components/auth-provider.tsx` (whether to draw a write control).
Both are cosmetic — they decide what to paint, exactly as `AuthGuard` does for the session. The
API is the enforcement. Tests: `api/test/roles.test.ts` (the allowlist) and
`api/test/reviewer-access.test.ts` (that it is actually wired to the hook).

## Configuring it (deploy)

Nothing is required for auth to work. What exists is cookie policy and session lifetime:

| Variable | Default | Meaning |
| --- | --- | --- |
| `SESSION_TTL_HOURS` | `168` (7 days) | Idle timeout. It **slides** on use, so an active user is not thrown out mid-task. |
| `AUTH_COOKIE_SAMESITE` | `lax` | See below. |
| `AUTH_COOKIE_SECURE` | `true` in production | Refused as `false` in production. |
| `AUTH_COOKIE_DOMAIN` | — | Only to share the cookie across subdomains (`.example.com`). |
| `AUTH_COOKIE_NAME` | `networkintel_session` | |

**SameSite.** `lax` is correct whenever the site and the API share a registrable domain —
including `localhost:3000` → `localhost:4000`, because the port is *not* part of the "site".
Only a genuinely cross-site deployment needs `none`, and browsers then require `Secure`.
Setting `none` without it is refused at boot, because the browser would silently drop the
cookie and the symptom — "login succeeds, then nothing is signed in" — is miserable to debug.

**CORS.** The API sets `credentials: true` with an explicit origin. `CORS_ORIGIN` is required
in production and must list the frontend's origin exactly; a wildcard cannot carry cookies.

### Local development

`npm run dev` requires a real Center sign-in, so set `CENTER_PLAYME_URL` and create an
`app_user` row for a Center account you can actually use (above).

If you'd rather not talk to Center at all, `AUTH_DISABLED=1` turns auth off entirely and treats
every request as a local admin (`dev@localhost`), so the app works against an empty database.
The server logs a loud warning at boot, and **production refuses to start** with it set
(`api/src/config/env.ts`). It is now the only way to run without Center - there is no local
password to fall back on.

## Brute force

`POST /api/auth/center/login` allows **5 failed attempts per (email, IP) per 15 minutes**, then
429s. Keyed on both, so one attacker cannot lock a victim out of their own account from
elsewhere.

**This matters more than an ordinary rate limit, and the reason is easy to miss.** Center runs
its *own* lockout - roughly five tries, then fifteen minutes. An unthrottled proxy in front of
it does not merely fail repeatedly; it spends a real person's **Center** attempts and locks
them out of Center itself. So the throttle is checked *before* Center is dialled, and a Center
outage (503) deliberately does **not** count against the caller.

The counter is **in-memory, so it is per-process**: behind N replicas an attacker gets N x 5
tries. That is a real limitation, and the reason to put a shared limiter at the edge in a
serious deployment - but a per-process cap is still the difference between thousands of
guesses a minute and five.

Sign-in answers *identically* for a wrong password and for an email with no Center account, so
the endpoint cannot be used to discover who has one. Center's own `life:`/`lock_time:` detail
is deliberately not echoed back for the same reason.

## Where the frontend does this

| | |
| --- | --- |
| `frontend/app/login/page.tsx` | The login page. |
| `frontend/components/auth-provider.tsx` | Who is signed in; `signInWithCenter` / `signOut`; `usePermissions()`. |
| `frontend/components/auth-guard.tsx` | Gates everything under `(app)`. |
| `frontend/lib/auth/session.ts` | The 401 seam. No token — by design. |

The guard is a **client** guard, necessarily: the cookie belongs to the API's origin, so Next
middleware cannot see it. It only decides what to *paint*. The real enforcement is the API's
`onRequest` hook, which 401s every request without a session — bypassing the guard in devtools
gets you an empty shell that cannot load a single row.

## Multi-user

`req.user.sub` is now a real `app_user` id, so the pieces are in place, but ownership is still
single-tenant: history rows are owned by `DEFAULT_USER_ID` (`api/src/config/constants.ts`), and
`company_contact` / `friend` are global cumulative tables. Making this multi-tenant means
replacing `DEFAULT_USER_ID` with `req.user.sub` and scoping those tables per user or workspace.
