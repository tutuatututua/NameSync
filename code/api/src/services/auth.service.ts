import { randomBytes } from "node:crypto";
import { AuthSessionModel, UserModel } from "../models";
import type { AppUser } from "../db.types";
import { Conflict, TooManyRequests } from "../lib/errors";
import { hashPassword } from "../lib/password";
import { hashToken, newSessionToken, sessionExpiry, sessionTtlMs, type SessionUser } from "../lib/session";

/**
 * The login flow itself.
 *
 * Everything a caller needs to know: a token is returned exactly once, from `login`. It is
 * never stored, never logged and never returned again — the database only ever sees its
 * SHA-256 (lib/session.ts).
 */

export const toSessionUser = (u: AppUser): SessionUser => ({
  sub: u.id,
  email: u.email,
  name: u.name ?? undefined,
  roles: u.roles ?? [],
});

// ── Throttling ───────────────────────────────────────────────────────────────
// Password guessing is the attack this endpoint actually faces, and scrypt alone only
// makes each guess expensive, not rare. This caps the guesses.
//
// In-memory, so it is per-process: it protects a single API instance, and behind several
// replicas an attacker gets LIMIT tries per replica. That is a real limitation and the
// reason to put a shared limiter at the edge in a serious deployment — but a per-process
// cap is still the difference between thousands of guesses a minute and five.
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;

const attempts = new Map<string, { count: number; resetAt: number }>();

function throttleKey(email: string, ip: string | undefined): string {
  // Keyed on both, so one attacker cannot lock a victim out of their own account by
  // burning the limit against their email from somewhere else.
  return `${email.trim().toLowerCase()}|${ip ?? "-"}`;
}

function checkThrottle(key: string): void {
  const entry = attempts.get(key);
  if (!entry) return;
  if (Date.now() > entry.resetAt) {
    attempts.delete(key);
    return;
  }
  if (entry.count >= MAX_ATTEMPTS) {
    const minutes = Math.max(1, Math.ceil((entry.resetAt - Date.now()) / 60_000));
    throw new TooManyRequests(`Too many sign-in attempts. Try again in ${minutes} minute(s).`);
  }
}

function recordFailure(key: string): void {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || now > entry.resetAt) {
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return;
  }
  entry.count += 1;
}

/** Opportunistic sweep — the map is tiny, but it should not grow without bound. */
function pruneThrottle(): void {
  if (attempts.size < 1000) return;
  const now = Date.now();
  for (const [key, entry] of attempts) if (now > entry.resetAt) attempts.delete(key);
}

/** Test seam: the suite logs in repeatedly and must not trip the limiter. */
export function resetThrottle(): void {
  attempts.clear();
}

// ── The flow ─────────────────────────────────────────────────────────────────

export interface LoginResult {
  /** The plaintext session token. The caller puts it in a cookie and then forgets it. */
  token: string;
  user: SessionUser;
  expiresAt: Date;
}

/*
 * `verifyCredentials` and `login` were deleted on 2026-08-04 with the local password path.
 * They read app_user.password_hash, which nothing reads any more — Center verifies the
 * password, and this app only decides whether the person it vouches for is allowed in.
 */

/**
 * The throttle, as the Center path uses it.
 *
 * It used to be private to `verifyCredentials`. When that went, the throttle went with it and
 * the ONE remaining way in had no rate limit at all — so these three exist to keep it.
 *
 * It matters more here than it did on the local path, not less. Center runs its own lockout
 * (roughly five tries, then fifteen minutes), so an unthrottled proxy in front of it does not
 * merely fail repeatedly — it spends a real person's Center attempts and locks them out of
 * Center itself. Failing here first is what keeps a guesser from doing that.
 */
export function checkLoginThrottle(email: string, ip: string | undefined): void {
  checkThrottle(throttleKey(email, ip));
  pruneThrottle();
}

export function recordLoginFailure(email: string, ip: string | undefined): void {
  recordFailure(throttleKey(email, ip));
}

/** A completed sign-in clears the slate. */
export function clearLoginThrottle(email: string, ip: string | undefined): void {
  attempts.delete(throttleKey(email, ip));
}

/**
 * Mint a session for an already-authenticated user: a fresh token, its hash stored as a
 * row, the last-login stamp bumped. The single place a session comes into being — the local
 * password path (above) and the Center path (services/center-auth.service.ts) both end here,
 * so there is exactly one kind of session no matter how the user proved who they are.
 *
 * It takes an authenticated user as a given; deciding *whether* to trust them is the caller's
 * job, done before this is ever reached.
 */
export async function issueSession(
  user: AppUser,
  meta: { userAgent?: string; ip?: string } = {}
): Promise<LoginResult> {
  const token = newSessionToken();
  const expiresAt = sessionExpiry();
  await AuthSessionModel.create({
    userId: user.id,
    tokenHash: hashToken(token),
    expiresAt,
    userAgent: meta.userAgent,
    ip: meta.ip,
  });
  // The same address on both rows, and on purpose: auth_session.ip is per-session and dies
  // with it, app_user.last_login_ip survives on the account. Both paths into this function
  // (local password, Center) carry the address, so neither can quietly skip recording it.
  await UserModel.touchLastLogin(user.id, meta.ip);

  return { token, user: toSessionUser(user), expiresAt };
}

/**
 * Who does this token belong to? `undefined` for anything that isn't a live session —
 * expired, revoked, forged, or belonging to a disabled account.
 *
 * Called on every authenticated request, so it is one indexed query. It also slides the
 * expiry, but only past the session's half-life, so an active tab doesn't write a row per
 * request just to say it is still here.
 */
export async function resolveSession(token: string): Promise<SessionUser | undefined> {
  const session = await AuthSessionModel.findActive(hashToken(token));
  if (!session) return undefined;

  const remaining = new Date(session.expires_at).getTime() - Date.now();
  if (remaining < sessionTtlMs() / 2) {
    // Best-effort: failing to extend the session must not fail the request the user is
    // actually making. They keep the time they have left.
    await AuthSessionModel.touch(session.id, sessionExpiry()).catch(() => {});
  }

  return toSessionUser(session.user);
}

/** Sign out. Idempotent: signing out twice, or with a stale token, is not an error. */
export async function logout(token: string): Promise<void> {
  await AuthSessionModel.deleteByTokenHash(hashToken(token));
}

/**
 * Create a user. There is no public sign-up: this is reached either by an admin (POST
 * /api/auth/users) or by the `npm run create-user` CLI, which is how the first account —
 * necessarily an admin — comes into being.
 */
export async function createUser(input: {
  email: string;
  name?: string;
  roles?: string[];
}): Promise<SessionUser> {
  const email = input.email.trim();

  // The unique index on lower(email) is the real guard against a duplicate; this check
  // exists to turn the race's loser into a clean 409 rather than a 500.
  if (await UserModel.findByEmail(email)) {
    throw new Conflict("An account with that email already exists");
  }

  const user = await UserModel.create({
    email,
    // app_user.password_hash is NOT NULL, but nothing reads it any more — Center holds the
    // credential. Hash 32 random bytes nobody has ever seen rather than accept one from the
    // caller: a column that must hold *something* should hold something unusable, not a
    // password someone might reasonably believe still signs them in.
    passwordHash: await hashPassword(randomBytes(32).toString("base64url")),
    name: input.name ?? null,
    // Defaults to `user`, not `[]`. Since lib/roles.ts default-denies, an account created
    // with no roles would be able to sign in and then be refused every endpoint — a
    // confusing way to spell "full access", which is what an omitted `roles` used to mean.
    roles: input.roles?.length ? input.roles : ["user"],
  });

  return toSessionUser(user);
}

/*
 * `changePassword` was deleted on 2026-08-04. It rotated app_user.password_hash, which no
 * longer signs anyone in — so it would have changed a credential that does nothing while
 * leaving the real one (the Center password) untouched. Passwords are changed in Center.
 */
