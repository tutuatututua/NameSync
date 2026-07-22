import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  apiSuccess,
  ApiMessageSchema,
  AuthSessionDataSchema,
  AuthUserSchema,
  CenterLoginBodySchema,
  CenterLoginDataSchema,
  ChangePasswordBodySchema,
  CreateUserBodySchema,
  LoginBodySchema,
  type AuthUser,
} from "@extensions/contract";
import { isProduction } from "../config/env";
import { Forbidden, Unauthorized } from "../lib/errors";
import { ok } from "../lib/http";
import { bearerToken, clearSessionCookie, SESSION_COOKIE, setSessionCookie } from "../lib/session";
import { readCookie } from "../lib/cookies";
import { changePassword, createUser, login, logout } from "../services/auth.service";
import { signInWithCenter } from "../services/center-auth.service";
import type { SessionUser } from "../lib/session";

/**
 * /api/auth — the login flow.
 *
 * Only POST /login is public (the allowlist lives in plugins/auth.ts); everything else
 * here runs behind the same guard as the rest of the app. /me deliberately 401s when
 * signed out — that is the signal the frontend's AuthGuard waits for.
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
  // again with `code`. On success we mint NameSync's own session — Center's token never
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

  // ── Sign in with a local password (dev only) ──────────────────────────────
  // Retained for local development against a database of your own accounts. Refused in
  // production, where Center is the only identity source — so a prod deploy cannot be entered
  // with a NameSync-local password even if one somehow exists on a row.
  app.post(
    "/login",
    { schema: { body: LoginBodySchema, response: { 200: apiSuccess(AuthSessionDataSchema) } } },
    async (req, reply) => {
      if (isProduction) {
        throw new Forbidden("Password sign-in is disabled here. Sign in with Center.");
      }
      const { token, user } = await login(req.body.email, req.body.password, {
        userAgent: req.headers["user-agent"],
        ip: ipOf(req),
      });
      setSessionCookie(reply, token);
      return ok({ user: toAuthUser(user) });
    }
  );

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

  // ── Change my password ────────────────────────────────────────────────────
  // Revokes every session, this one included — so the reply also clears the cookie and the
  // user signs in again. Anything less leaves the sessions they were trying to cut loose.
  app.post(
    "/change-password",
    { schema: { body: ChangePasswordBodySchema, response: { 200: ApiMessageSchema } } },
    async (req, reply) => {
      if (!req.user) throw new Unauthorized("Not signed in");
      await changePassword(req.user.sub, req.body.current_password, req.body.new_password);
      clearSessionCookie(reply);
      return { success: true as const, message: "Password changed — please sign in again" };
    }
  );

  // ── Create a user ─────────────────────────────────────────────────────────
  // Admins only. There is no public sign-up, by design: NameSync is an internal tool, so
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
        password: req.body.password,
        name: req.body.name,
        roles: req.body.roles,
      });
      return ok(toAuthUser(user));
    }
  );
}
