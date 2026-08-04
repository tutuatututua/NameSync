import { z } from 'zod';

/**
 * Authentication. Network Intel signs people in itself — there is no external issuer and no
 * JWT any more; the API mints an opaque session token and puts it in an httpOnly cookie.
 * See api/src/lib/session.ts for why, and docs/AUTH.md for the deploy story.
 */

/**
 * The roles an account can hold.
 *
 *   user      — the whole app: import, run the matcher, edit data, browse everything.
 *   reviewer  — the Network workspace, READ ONLY. No imports, no runs, no edits, and no
 *               Uploads or Data page at all. See ROLE_ACCESS in api/src/lib/roles.ts for
 *               the exact endpoint allowlist that enforces it.
 *   admin     — `user`, plus managing accounts (POST /api/auth/users).
 *
 * `roles` stays a free-form string[] on the wire because that is what the column is; these
 * are the values that carry meaning. An account with none of them can sign in and reach
 * nothing, which is the safe way for an unrecognised value to fail.
 */
export const ROLES = ['admin', 'user', 'reviewer'] as const;
export const RoleSchema = z.enum(ROLES);
export type Role = z.infer<typeof RoleSchema>;

/** True when these roles grant the full app rather than the reviewer's read-only slice. */
export const hasFullAccess = (roles: readonly string[]): boolean =>
  roles.includes('admin') || roles.includes('user');

/** True when the account is a reviewer and nothing more — the restricted view. */
export const isReviewerOnly = (roles: readonly string[]): boolean =>
  roles.includes('reviewer') && !hasFullAccess(roles);

/** The signed-in user, as every client sees them. Never carries the password hash. */
export const AuthUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  roles: z.array(z.string()),
});
export type AuthUser = z.infer<typeof AuthUserSchema>;

export const LoginBodySchema = z.object({
  email: z.string().min(1, 'Email is required').email('Enter a valid email address'),
  // Only a presence check: an existing account's password must keep working even if the
  // strength rules are tightened later. The rules that matter are on the *set* path below.
  password: z.string().min(1, 'Password is required'),
});
export type LoginBody = z.infer<typeof LoginBodySchema>;

/**
 * Length is the only requirement. Composition rules ("one capital, one symbol") push people
 * toward Passw0rd! — a long passphrase beats a short mangled word.
 *
 * The floor is 8, lowered from 12 by request. Be aware of what that buys an attacker: 8
 * characters is inside the range of an offline dictionary/brute-force attack, and it admits
 * every password on the standard wordlists ("12345678", "password"). The only thing standing
 * between those and an account is the login throttle (5 tries per 15 min per email+IP), which
 * is in-memory and therefore per-process — see docs/AUTH.md. Raise this back to 12 when the
 * accounts here stop being throwaways.
 */
export const PasswordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(200, 'Password must be at most 200 characters');

/** Admin-only user creation (POST /api/auth/users). There is no public sign-up. */
export const CreateUserBodySchema = z.object({
  email: z.string().email('Enter a valid email address'),
  password: PasswordSchema,
  name: z.string().max(255).optional(),
  // Validated against the known roles rather than accepting any string: a typo like
  // "reviewers" would otherwise create an account that silently grants nothing, and the
  // mistake would surface as "why can't they see anything" long after the fact.
  roles: z.array(RoleSchema).optional(),
});
export type CreateUserBody = z.infer<typeof CreateUserBodySchema>;

export const ChangePasswordBodySchema = z.object({
  current_password: z.string().min(1, 'Current password is required'),
  new_password: PasswordSchema,
});
export type ChangePasswordBody = z.infer<typeof ChangePasswordBodySchema>;

/** `{ user }` — what /login and /me return. The token is in the cookie, never the body. */
export const AuthSessionDataSchema = z.object({ user: AuthUserSchema });
export type AuthSessionData = z.infer<typeof AuthSessionDataSchema>;

// ── Center sign-in ────────────────────────────────────────────────────────────
// The production login. Network Intel's own form posts here; the API forwards the
// credentials to Center (centerapp.io), and on success mints its OWN session cookie —
// Center's token is used once and discarded. See docs/AUTH.md and
// docs/wayfinder/assets/06-center-sso-integration-spec.md.
//
// The second factors Network Intel relays. All three are delivered by Center itself — an
// authenticator app (`totp`), an emailed code (`email`), or a texted code (`sms`). For email
// and sms the code is one Center generates and sends; we only relay the challenge and the
// user's answer.
export const TwoFactorMethodSchema = z.enum(['totp', 'email', 'sms']);
export type TwoFactorMethod = z.infer<typeof TwoFactorMethodSchema>;

/**
 * One endpoint, two steps. The first call carries just email+password; if Center demands a
 * second factor the API answers with a challenge and the client calls again — same
 * email+password, now with `code` (and `method`/`ref` echoed back from the challenge).
 *
 * The password is re-sent on the second step because the proxy is stateless — it holds no
 * half-finished login between the two calls, exactly as Center's own client works.
 */
export const CenterLoginBodySchema = z.object({
  email: z.string().min(1, 'Email is required').email('Enter a valid email address'),
  password: z.string().min(1, 'Password is required'),
  /** The 6-digit second factor, on the second (2FA) call only. */
  code: z.string().min(1).max(12).optional(),
  method: TwoFactorMethodSchema.optional(),
  /** The email-OTP reference handed back by the challenge; echoed on the second call. */
  ref: z.string().optional(),
});
export type CenterLoginBody = z.infer<typeof CenterLoginBodySchema>;

/** Not-signed-in-yet: Center wants a second factor. No cookie is set with this response. */
export const TwoFactorChallengeSchema = z.object({
  twoFactorRequired: z.literal(true),
  method: TwoFactorMethodSchema,
  /** The reference to echo back (email OTP). `null` for TOTP, which needs no reference. */
  ref: z.string().nullable(),
});
export type TwoFactorChallenge = z.infer<typeof TwoFactorChallengeSchema>;

/** The Center login answers with either a completed session (`{ user }`) or a 2FA challenge. */
export const CenterLoginDataSchema = z.union([AuthSessionDataSchema, TwoFactorChallengeSchema]);
export type CenterLoginData = z.infer<typeof CenterLoginDataSchema>;

// ── Email-OTP sign-in (Network Intel-owned) ─────────────────────────────────────────
// A second login path that Network Intel runs itself — no external issuer. Two factors:
// the account password, then a one-time code Network Intel generates and emails. It works
// in every environment (unlike the dev-only local /login), and unlike Center the code
// is minted and sent from here (api/src/services/otp-auth.service.ts).
//
// Same two-step, stateless shape as Center: the first call carries email+password, the
// API verifies them, emails a code and answers with a challenge (`ref` = the code's id);
// the client calls again with the same email+password plus `code` and the echoed `ref`.
// The password is re-sent on step two on purpose — the API holds no half-finished login
// between calls, so knowing the password is proven again at the moment the code is spent.
export const OtpLoginBodySchema = z.object({
  email: z.string().min(1, 'Email is required').email('Enter a valid email address'),
  password: z.string().min(1, 'Password is required'),
  /** The emailed code, on the second (verify) call only. Digits, but validated server-side. */
  code: z.string().min(1).max(12).optional(),
  /** The challenge reference (the code's id) handed back by step one; echoed on step two. */
  ref: z.string().optional(),
});
export type OtpLoginBody = z.infer<typeof OtpLoginBodySchema>;

/**
 * Step one's answer: a code has been emailed, no cookie set yet. `method` is always
 * `email` here — this path has no other factor — and `ref` is always present (the id the
 * client must echo back), so it reuses TwoFactorChallengeSchema's shape without its nulls.
 */
export const OtpLoginDataSchema = z.union([AuthSessionDataSchema, TwoFactorChallengeSchema]);
export type OtpLoginData = z.infer<typeof OtpLoginDataSchema>;
