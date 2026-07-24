# Authentication

NameSync **signs people in itself**. It owns the users, the passwords and the sessions.

It used to do the opposite: it sat behind a website that logged the user in and handed over
a JWT, and NameSync only ever *verified* one — no login page, no password, no session store.
That inverted when the app became the thing people actually visit. There is no external
issuer any more, so there is nothing to agree with it about: **no secret, no issuer, no
audience, no JWKS URL**. An entire class of deploy-time misconfiguration went with them.

## The shape of it

| | |
| --- | --- |
| **Users** | `app_user`. Passwords hashed with scrypt (`api/src/lib/password.ts`). |
| **Sessions** | `auth_session`. A 32-byte random token; the table stores only its SHA-256. |
| **Transport** | An `httpOnly` cookie (`namesync_session`), set by `POST /api/auth/login`. |
| **The guard** | A global `onRequest` hook — `api/src/plugins/auth.ts`. |

Two properties are worth stating plainly, because they are the reasons for the design:

**A session is a row, so it can be revoked.** Signing out, disabling an account, or changing
a password takes effect on the *next request*. A JWT cannot do this — it is a signed claim
the server can only verify, so a stolen one stays valid until it expires, and "sign out" is a
lie the client tells itself.

**The token is `httpOnly`, so script cannot read it.** The old JWT lived in `localStorage`,
which meant any XSS bug on the page could walk off with the session. Nothing in the frontend
can now read the token, because nothing is ever given it — the browser attaches the cookie
by itself (`credentials: "include"`).

## Creating the first account

There is **no public sign-up**, deliberately: NameSync is an internal tool, and an open
`/register` would put the data behind nothing at all. So the first account is made from the
command line, and it must be an admin — otherwise no one can create the second one.

```bash
cd code/api
npm run create-user -- you@example.com 'a long passphrase' --name "Your Name" --admin
```

This needs `app_user` / `auth_session` to exist already — they are created by
`docs/schema-redesign.sql` along with the rest of the schema (see [DB.md](DB.md)), or by
`docs/add-auth.sql` if you are adding auth to a database that predates it.

After that, an admin creates users through the API (`POST /api/auth/users`).

Passwords must be **at least 8 characters**, and that is the only rule. Composition rules
("one capital, one symbol") push people towards `Passw0rd!`; a long passphrase is stronger
and easier to remember.

> The floor was **lowered from 12 to 8 on request**. It is worth being clear-eyed about the
> cost: 8 characters is within reach of an offline brute-force, and it admits every password
> on the standard wordlists. The only thing between those and an account is the login throttle
> below — which is per-process, not per-cluster. Raise it back to 12 (`PasswordSchema` in
> `extensions/contract/src/auth.ts`, and the check in `api/src/scripts/create-user.ts`) once
> the accounts stop being throwaways.

## Endpoints

| Route | Auth | |
| --- | --- | --- |
| `POST /api/auth/login` | public | `{email, password}` → sets the cookie, returns the user. Single factor; **dev-only** (refused in production). |
| `POST /api/auth/otp/login` | public | Password **+ emailed code**, two-factor. Works in every environment. See below. |
| `POST /api/auth/center/login` | public | Forward to Center; Center owns the second factor. The production default. |
| `POST /api/auth/logout` | any | Deletes the session row. Always clears the cookie. |
| `GET /api/auth/me` | session | The signed-in user. **401 when signed out** — this is how the frontend asks. |
| `POST /api/auth/change-password` | session | Revokes every session, the caller's included. |
| `POST /api/auth/users` | **admin** | Create a user. |

The token is returned **only** as a `Set-Cookie`, never in a response body — so it stays out
of logs, out of browser history, and out of reach of script.

`Authorization: Bearer <token>` is also accepted, for scripts and tests that read the token
off the `Set-Cookie` themselves. It is the same opaque session token, looked up the same way;
there is no second code path.

## Email one-time-code sign-in (2FA)

`POST /api/auth/otp/login` is NameSync's own two-factor login: the password is the **first**
factor, and NameSync then **emails a 6-digit code** that must be entered to finish. It is the
same two-step, stateless shape as the Center path — and unlike the plain `/login`, it works in
every environment, Center or no Center.

**The flow.** One endpoint, two calls (`api/src/services/otp-auth.service.ts`):

1. `{email, password}` → the password is verified; on success a fresh code is generated, only
   its **scrypt hash** is stored (`email_otp`), the plaintext is emailed, and the reply is a
   challenge `{twoFactorRequired: true, method: "email", ref}` with **no cookie**.
2. `{email, password, code, ref}` → the password is verified *again* (nothing is held between
   the two calls) and the code is checked. On success the session cookie is set.

**Why the code is safe at rest.** A 6-digit code is instantly reversible from a fast hash, so
it gets the same scrypt treatment as a password — a dump of `email_otp` yields nothing
replayable. Each code is **single-use** (consumed atomically, so it can't be spent twice),
**short-lived** (`OTP_TTL_MINUTES`, default 10), and **burns after `OTP_MAX_ATTEMPTS` wrong
guesses** (default 5). Requesting a new code invalidates any the user was still holding.

**Delivery** is over SMTP (`api/src/lib/mailer.ts`, `nodemailer`). With `SMTP_HOST` set, mail
is sent; unset in dev/test, the mailer **logs the code to the server log** so the flow works
with no mail server. See the SMTP/OTP block in `.env.example`.

**The table.** `email_otp` — apply `docs/add-otp-login.sql` to a live database (a fresh schema
from `docs/schema-redesign.sql` already has it). Drive the frontend to this path with
`NEXT_PUBLIC_AUTH_MODE=local` (the login page's `local` mode now runs this two-step).

## What's protected

Everything, via the global hook. The exceptions, all deliberate:

- `POST /api/auth/login`, `/api/auth/otp/login`, `/api/auth/center/login` — where a session comes from.
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

## Configuring it (deploy)

Nothing is required for auth to work. What exists is cookie policy and session lifetime:

| Variable | Default | Meaning |
| --- | --- | --- |
| `SESSION_TTL_HOURS` | `168` (7 days) | Idle timeout. It **slides** on use, so an active user is not thrown out mid-task. |
| `AUTH_COOKIE_SAMESITE` | `lax` | See below. |
| `AUTH_COOKIE_SECURE` | `true` in production | Refused as `false` in production. |
| `AUTH_COOKIE_DOMAIN` | — | Only to share the cookie across subdomains (`.example.com`). |
| `AUTH_COOKIE_NAME` | `namesync_session` | |

**SameSite.** `lax` is correct whenever the site and the API share a registrable domain —
including `localhost:3000` → `localhost:4000`, because the port is *not* part of the "site".
Only a genuinely cross-site deployment needs `none`, and browsers then require `Secure`.
Setting `none` without it is refused at boot, because the browser would silently drop the
cookie and the symptom — "login succeeds, then nothing is signed in" — is miserable to debug.

**CORS.** The API sets `credentials: true` with an explicit origin. `CORS_ORIGIN` is required
in production and must list the frontend's origin exactly; a wildcard cannot carry cookies.

### Local development

With no `AUTH_*` set, `npm run dev` requires a real sign-in — so create a user (above) and use
it. If you'd rather not, `AUTH_DISABLED=1` turns auth off entirely and treats every request as
a local admin (`dev@localhost`), so the app works against an empty database. The server logs a
loud warning at boot, and **production refuses to start** with it set (`api/src/config/env.ts`).

## Brute force

The password check — shared by `/api/auth/login` and `/api/auth/otp/login` (both go through
`verifyCredentials`) — allows **5 failed attempts per (email, IP) per 15 minutes**, then 429s.
Keyed on both, so one attacker cannot lock a victim out of their own account from elsewhere.
The emailed code has its **own** cap on top of this: `OTP_MAX_ATTEMPTS` wrong guesses (default
5) burn the code, so guessing the second factor is bounded independently of the password.

The counter is **in-memory, so it is per-process**: behind N replicas an attacker gets N × 5
tries. That is a real limitation, and the reason to put a shared limiter at the edge in a
serious deployment — but a per-process cap is still the difference between thousands of
guesses a minute and five.

Sign-in also answers *identically* — same message, same status, same amount of work — for a
wrong password and for an email with no account, so the endpoint cannot be used to discover
who has one. (The "same amount of work" part is why `lib/password.ts` hashes against a decoy
when the user doesn't exist: otherwise the response time gives the answer away.)

## Where the frontend does this

| | |
| --- | --- |
| `frontend/app/login/page.tsx` | The login page. |
| `frontend/components/auth-provider.tsx` | Who is signed in; `signIn` / `signOut`. |
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
