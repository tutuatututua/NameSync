import { z } from 'zod';

/**
 * Authentication. Center (centerapp.io) is the sole identity source: it owns the password and
 * any second factor, and Network Intel decides who is allowed in and with what role. On a
 * successful Center login the API mints its OWN opaque session token and puts it in an
 * httpOnly cookie — Center's own token is read once and discarded.
 *
 * See api/src/lib/session.ts for why the session is a row rather than a JWT, and docs/AUTH.md
 * for the deploy story.
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

/*
 * LoginBodySchema, PasswordSchema and ChangePasswordBodySchema were removed on 2026-08-04
 * with the local password path. Center owns passwords now: there is no password for this app
 * to check, set, or have an opinion about the strength of.
 */

/**
 * Admin-only user creation (POST /api/auth/users). There is no public sign-up.
 *
 * No password field. An account here is an AUTHORISATION record — it says a Center identity is
 * allowed in and with what role; Center holds the credential. `app_user.password_hash` is
 * still NOT NULL in the schema, so the server writes an unusable random value and nothing
 * ever reads it.
 */
export const CreateUserBodySchema = z.object({
  email: z.string().email('Enter a valid email address'),
  name: z.string().max(255).optional(),
  // Validated against the known roles rather than accepting any string: a typo like
  // "reviewers" would otherwise create an account that silently grants nothing, and the
  // mistake would surface as "why can't they see anything" long after the fact.
  roles: z.array(RoleSchema).optional(),
});
export type CreateUserBody = z.infer<typeof CreateUserBodySchema>;

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

/*
 * The email-OTP schemas (OtpLoginBodySchema / OtpLoginDataSchema) were removed on
 * 2026-08-04 along with the path they described — Network Intel's own password plus a code
 * it emailed itself. Center generates and sends any second factor now, so nothing here
 * mints a code.
 */
