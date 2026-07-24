import { AuthSessionModel, UserModel } from "../models";
import type { AppUser } from "../db.types";
import { Conflict, TooManyRequests, Unauthorized } from "../lib/errors";
import { DUMMY_HASH, hashPassword, verifyPassword } from "../lib/password";
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

/**
 * Prove an email+password pair, and return the user it belongs to — without minting a
 * session. This is the shared, throttled front half of every password-based sign-in: the
 * plain local `login` below ends in a session, the email-OTP path (otp-auth.service.ts)
 * ends in a code instead, but both must first get past exactly this check, the same way.
 *
 * Every failure — unknown email, wrong password, disabled account — raises the same 401 with
 * the same message and after the same amount of work, so the response can't be used to
 * discover which emails have accounts.
 */
export async function verifyCredentials(
  email: string,
  password: string,
  meta: { userAgent?: string; ip?: string } = {}
): Promise<AppUser> {
  const key = throttleKey(email, meta.ip);
  checkThrottle(key);
  pruneThrottle();

  const user = await UserModel.findByEmail(email);

  // Hash against a decoy when there is no user, so the timing is the same either way.
  const hash = user?.password_hash ?? (await DUMMY_HASH);
  const passwordOk = await verifyPassword(password, hash);

  if (!user || !passwordOk || !user.is_active) {
    recordFailure(key);
    throw new Unauthorized("Incorrect email or password");
  }

  attempts.delete(key); // a success clears the slate
  return user;
}

/**
 * Sign in with a password alone. Verifies the credentials and immediately issues a session —
 * the single-factor path, used by the dev-only local /login.
 */
export async function login(
  email: string,
  password: string,
  meta: { userAgent?: string; ip?: string } = {}
): Promise<LoginResult> {
  const user = await verifyCredentials(email, password, meta);
  return issueSession(user, meta);
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
  await UserModel.touchLastLogin(user.id);

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
  password: string;
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
    passwordHash: await hashPassword(input.password),
    name: input.name ?? null,
    roles: input.roles ?? [],
  });

  return toSessionUser(user);
}

/**
 * Change a password, then revoke every session the user has — including, deliberately,
 * the one they are changing it from. A password change that leaves the old sessions alive
 * does not achieve the thing people change their password *for*.
 */
export async function changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
  const user = await UserModel.findById(userId);
  if (!user || !(await verifyPassword(currentPassword, user.password_hash))) {
    throw new Unauthorized("Current password is incorrect");
  }
  await UserModel.setPassword(userId, await hashPassword(newPassword));
  await AuthSessionModel.deleteAllForUser(userId);
}
