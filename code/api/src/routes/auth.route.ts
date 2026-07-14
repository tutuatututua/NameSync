import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  apiSuccess,
  ApiMessageSchema,
  AuthSessionDataSchema,
  AuthUserSchema,
  ChangePasswordBodySchema,
  CreateUserBodySchema,
  LoginBodySchema,
  type AuthUser,
} from "@extensions/contract";
import { Forbidden, Unauthorized } from "../lib/errors";
import { ok } from "../lib/http";
import { bearerToken, clearSessionCookie, SESSION_COOKIE, setSessionCookie } from "../lib/session";
import { readCookie } from "../lib/cookies";
import { changePassword, createUser, login, logout } from "../services/auth.service";
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

  // ── Sign in ───────────────────────────────────────────────────────────────
  app.post(
    "/login",
    { schema: { body: LoginBodySchema, response: { 200: apiSuccess(AuthSessionDataSchema) } } },
    async (req, reply) => {
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
