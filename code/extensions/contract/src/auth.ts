import { z } from 'zod';

/**
 * Authentication. NameSync signs people in itself — there is no external issuer and no
 * JWT any more; the API mints an opaque session token and puts it in an httpOnly cookie.
 * See api/src/lib/session.ts for why, and docs/AUTH.md for the deploy story.
 */

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
  roles: z.array(z.string()).optional(),
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
// The production login. NameSync's own form posts here; the API forwards the
// credentials to Center (centerapp.io), and on success mints its OWN session cookie —
// Center's token is used once and discarded. See docs/AUTH.md and
// docs/wayfinder/assets/06-center-sso-integration-spec.md.
//
// The two second factors NameSync relays. SMS is deliberately excluded: a Center account
// set to SMS 2FA is rejected with a clear message rather than half-supported.
export const TwoFactorMethodSchema = z.enum(['totp', 'email']);
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
