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
  type AuthUser,
} from "@extensions/contract";
import { Forbidden, Unauthorized } from "../lib/errors";
import { ok } from "../lib/http";
import { bearerToken, clearSessionCookie, SESSION_COOKIE, setSessionCookie } from "../lib/session";
import { readCookie } from "../lib/cookies";
import { createUser, logout } from "../services/auth.service";
import { signInWithCenter } from "../services/center-auth.service";
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
