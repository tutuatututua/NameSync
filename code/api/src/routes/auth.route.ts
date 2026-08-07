import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  apiSuccess,
  ApiMessageSchema,
  AuthSessionDataSchema,
  AuthUserSchema,
  CenterLoginBodySchema,
  CenterLoginDataSchema,
  CreateUserBodySchema,
  TwoFactorReauthBodySchema,
  TwoFactorReauthDataSchema,
  TwoFactorStatusDataSchema,
  TwoFactorSetupDataSchema,
  TwoFactorEnableBodySchema,
  TwoFactorEnableDataSchema,
  TwoFactorSmsSendBodySchema,
  TwoFactorSmsSendDataSchema,
  type AuthUser,
} from "@extensions/contract";
import { Forbidden, Unauthorized } from "../lib/errors";
import { ok } from "../lib/http";
import { bearerToken, clearSessionCookie, hashToken, SESSION_COOKIE, setSessionCookie } from "../lib/session";
import { readCookie } from "../lib/cookies";
import { createUser, logout } from "../services/auth.service";
import { signInWithCenter } from "../services/center-auth.service";
import {
  beginReauth,
  disableTotp,
  enableSms,
  enableTotp,
  endReauth,
  getStatus,
  sendSmsCode,
  setupTotp,
} from "../services/two-factor.service";
import type { SessionUser } from "../lib/session";

/**
 * /api/auth — the login flow.
 *
 * Only POST /center/login is public (the allowlist lives in plugins/auth.ts); everything else
 * here runs behind the same guard as the rest of the app. /me deliberately 401s when
 * signed out — that is the signal the frontend's AuthGuard waits for.
 *
 * Center is the sole identity source: it owns the password and the second factor, and this
 * app owns who is allowed in and with what role. There is no local password path — see the
 * note where the two deleted routes used to be.
 *
 * The session token never appears in a response body, only in a Set-Cookie. That is what
 * keeps it out of reach of script, and out of logs and browser history.
 */

const toAuthUser = (u: SessionUser): AuthUser => ({
  id: u.sub,
  email: u.email,
  name: u.name ?? null,
  roles: u.roles,
});

/** The token on this request, whichever way it arrived. */
const tokenOf = (req: FastifyRequest): string | undefined =>
  readCookie(req.headers.cookie, SESSION_COOKIE()) ?? bearerToken(req.headers.authorization);

/** The client's address, for the throttle key and the session row. */
const ipOf = (req: FastifyRequest): string | undefined => req.ip;

/**
 * The key for THIS session's re-auth window (services/two-factor.service.ts). It is the hash
 * of the session token, so a window one session opened cannot be used by another — and it is
 * the same value the session is stored under, never something the client can spoof. Falls back
 * to the user id only when auth is disabled in dev (no token exists), where 2FA can't work anyway.
 */
const windowKeyOf = (req: FastifyRequest): string => {
  const token = tokenOf(req);
  return token ? hashToken(token) : `user:${req.user?.sub ?? "anon"}`;
};

export default async function authRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // ── Sign in with Center ───────────────────────────────────────────────────
  // The production path. One endpoint, two steps: the first call carries email+password; if
  // Center wants a second factor the response is a challenge (no cookie) and the client calls
  // again with `code`. On success we mint Network Intel's own session — Center's token never
  // touches the browser. See services/center-auth.service.ts.
  app.post(
    "/center/login",
    { schema: { body: CenterLoginBodySchema, response: { 200: apiSuccess(CenterLoginDataSchema) } } },
    async (req, reply) => {
      const result = await signInWithCenter({
        email: req.body.email,
        password: req.body.password,
        code: req.body.code,
        method: req.body.method,
        ref: req.body.ref,
        meta: { userAgent: req.headers["user-agent"], ip: ipOf(req) },
      });

      if (result.kind === "twoFactor") return ok(result.challenge);

      setSessionCookie(reply, result.session.token);
      return ok({ user: toAuthUser(result.session.user) });
    }
  );

  // Center is the ONLY way in. Two sign-in paths used to sit here beside it and were deleted
  // on 2026-08-04:
  //
  //   POST /login      — a password checked against app_user.password_hash
  //   POST /otp/login  — the same password, plus a one-time code Network Intel emailed itself
  //
  // Both were guarded only by NODE_ENV, and this deployment runs `development` on purpose
  // (production won't boot without SMTP/Center, and forces a Secure cookie that plain http
  // drops). So configuring Center did not close them: switching the login form to Center only
  // changed which endpoint the FORM called, and a plain curl to /api/auth/login still returned
  // an admin session — Center bypassed entirely, on a LAN-reachable host.
  //
  // Deleted rather than flagged off, because a second door that only a flag holds shut is the
  // kind of thing that gets reopened for a demo and left that way. `password_hash` is now
  // written (the column is NOT NULL) and never read.

  // ── Sign out ──────────────────────────────────────────────────────────────
  // Always 200, and always clears the cookie: a client trying to end a session it can no
  // longer prove it owns should still end up signed out, not stuck holding a dead token.
  app.post("/logout", { schema: { response: { 200: ApiMessageSchema } } }, async (req, reply) => {
    const token = tokenOf(req);
    if (token) await logout(token);
    // Drop any open re-auth window too, so a Center token can't outlive the session that opened it.
    endReauth(windowKeyOf(req));
    clearSessionCookie(reply);
    return { success: true as const, message: "Signed out" };
  });

  // ── Who am I ──────────────────────────────────────────────────────────────
  // The guard has already resolved the session, so this is a read of what it found.
  app.get("/me", { schema: { response: { 200: apiSuccess(AuthSessionDataSchema) } } }, async (req) => {
    if (!req.user) throw new Unauthorized("Not signed in");
    return ok({ user: toAuthUser(req.user) });
  });

  // POST /change-password went with them. It rotated app_user.password_hash, which nothing
  // reads any more — so it would have offered to change a credential that cannot sign you in,
  // and left the real one (the Center password) untouched. Passwords are changed in Center.

  // ── Manage two-factor authentication (proxying Center) ────────────────────
  // A signed-in user turns their Center authenticator on/off here without visiting Center.
  // Everything is gated behind a re-auth window: /reauth confirms the password (and current
  // factor, if any) and opens the window; the rest act inside it. See two-factor.service.ts.
  //
  // These are never public — they run behind the session guard like the rest of the app — so
  // the user is already known; the password re-confirmation is a second, fresher proof for a
  // sensitive change, not the primary authentication.

  // Confirm password → open the window. Answers with the current 2FA state, or a challenge if
  // the account already has 2FA on (then the client calls again with the code).
  app.post(
    "/2fa/reauth",
    { schema: { body: TwoFactorReauthBodySchema, response: { 200: apiSuccess(TwoFactorReauthDataSchema) } } },
    async (req) => {
      if (!req.user) throw new Unauthorized("Not signed in");
      const result = await beginReauth({
        email: req.user.email,
        password: req.body.password,
        code: req.body.code,
        method: req.body.method,
        ref: req.body.ref,
        windowKey: windowKeyOf(req),
        meta: { userAgent: req.headers["user-agent"], ip: ipOf(req) },
      });
      if (result.kind === "twoFactor") return ok(result.challenge);
      return ok({ method: result.method });
    }
  );

  // Re-read the current 2FA state (window must be open).
  app.get(
    "/2fa/status",
    { schema: { response: { 200: apiSuccess(TwoFactorStatusDataSchema) } } },
    async (req) => {
      if (!req.user) throw new Unauthorized("Not signed in");
      return ok({ method: await getStatus(windowKeyOf(req)) });
    }
  );

  // Start authenticator enrolment: a fresh secret + its otpauth URL for the QR.
  app.post(
    "/2fa/totp/setup",
    { schema: { response: { 200: apiSuccess(TwoFactorSetupDataSchema) } } },
    async (req) => {
      if (!req.user) throw new Unauthorized("Not signed in");
      return ok(await setupTotp(windowKeyOf(req)));
    }
  );

  // Finish enrolment: verify a code from the authenticator (Center activates TOTP on success).
  app.post(
    "/2fa/totp/enable",
    { schema: { body: TwoFactorEnableBodySchema, response: { 200: apiSuccess(TwoFactorEnableDataSchema) } } },
    async (req) => {
      if (!req.user) throw new Unauthorized("Not signed in");
      return ok(await enableTotp(windowKeyOf(req), req.body.code));
    }
  );

  // Start SMS enrolment: Center texts a code to the given number.
  app.post(
    "/2fa/sms/send-code",
    { schema: { body: TwoFactorSmsSendBodySchema, response: { 200: apiSuccess(TwoFactorSmsSendDataSchema) } } },
    async (req) => {
      if (!req.user) throw new Unauthorized("Not signed in");
      await sendSmsCode(windowKeyOf(req), {
        phoneCountry: req.body.phoneCountry,
        phoneNumber: req.body.phoneNumber,
      });
      return ok({ sent: true });
    }
  );

  // Finish SMS enrolment: verify the texted code (activates SMS 2FA on success).
  app.post(
    "/2fa/sms/enable",
    { schema: { body: TwoFactorEnableBodySchema, response: { 200: apiSuccess(TwoFactorEnableDataSchema) } } },
    async (req) => {
      if (!req.user) throw new Unauthorized("Not signed in");
      return ok(await enableSms(windowKeyOf(req), req.body.code));
    }
  );

  // Turn 2FA off.
  app.post(
    "/2fa/disable",
    { schema: { response: { 200: apiSuccess(TwoFactorStatusDataSchema) } } },
    async (req) => {
      if (!req.user) throw new Unauthorized("Not signed in");
      return ok(await disableTotp(windowKeyOf(req)));
    }
  );

  // Close the window explicitly (leaving the page / cancelling). Always 200 — closing a window
  // that is already gone is not an error.
  app.post("/2fa/end", { schema: { response: { 200: ApiMessageSchema } } }, async (req) => {
    endReauth(windowKeyOf(req));
    return { success: true as const, message: "Closed" };
  });

  // ── Create a user ─────────────────────────────────────────────────────────
  // Admins only. There is no public sign-up, by design: Network Intel is an internal tool, so
  // an open /register would let anyone on the internet into the data. The FIRST admin is
  // created out-of-band with `npm run create-user` — see docs/AUTH.md.
  app.post(
    "/users",
    { schema: { body: CreateUserBodySchema, response: { 200: apiSuccess(AuthUserSchema) } } },
    async (req) => {
      if (!req.user) throw new Unauthorized("Not signed in");
      if (!req.user.roles.includes("admin")) throw new Forbidden("Only an admin can create users");

      const user = await createUser({
        email: req.body.email,
        name: req.body.name,
        roles: req.body.roles,
      });
      return ok(toAuthUser(user));
    }
  );
}
