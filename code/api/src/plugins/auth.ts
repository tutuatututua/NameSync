import type { FastifyInstance, FastifyRequest } from "fastify";
import { Unauthorized } from "../lib/errors";
import { readCookie } from "../lib/cookies";
import { bearerToken, SESSION_COOKIE, type SessionUser } from "../lib/session";
import { resolveSession } from "../services/auth.service";

declare module "fastify" {
  interface FastifyRequest {
    /** Set by the auth hook. Undefined only on public routes. */
    user?: SessionUser;
  }
  interface FastifyInstance {
    /** True when verification is off (dev/test only — production refuses to boot this way). */
    authDisabled: boolean;
  }
}

/**
 * Routes reachable without signing in:
 *  - POST /api/auth/login, /api/auth/center/login and /api/auth/otp/login, because that is
 *    where a session comes from
 *  - health, so a load balancer can probe the app
 *  - the OpenAPI docs
 *  - the matcher callback, which is machine-to-machine and carries its own shared secret
 *    (X-Callback-Token) — the external service has no user to sign in as
 *  - the websocket handshake
 *
 * /ws is the one that is public and arguably shouldn't be. The browser does attach the
 * session cookie to a ws:// handshake, so guarding it is now *possible* in a way it wasn't
 * under the JWT (which could not be sent as a header from WebSocket). It is left open here
 * because it only ever emits comparison-progress events, and closing it is a behaviour
 * change worth making on its own rather than smuggling into this one. See docs/AUTH.md.
 */
const PUBLIC_PATHS = [
  /^\/api\/auth\/login$/,
  /^\/api\/auth\/center\/login$/,
  /^\/api\/auth\/otp\/login$/,
  /^\/api\/health/,
  /^\/docs/,
  /^\/api\/callbacks\//,
  /^\/ws/,
];

const isPublic = (url: string): boolean => {
  const path = url.split("?")[0];
  return PUBLIC_PATHS.some((re) => re.test(path));
};

/** AUTH_DISABLED is a flag, not a value: any non-empty, non-"false"/"0" string turns it on. */
const flag = (v: string | undefined): boolean => {
  const s = v?.trim().toLowerCase();
  return !!s && s !== "false" && s !== "0";
};

/**
 * Read the switch from the environment *at call time* rather than from the frozen
 * config/env singleton (which parses once at import). That is what lets a test build one
 * app with auth on and another with it off in the same process.
 */
export function resolveAuthDisabled(source: NodeJS.ProcessEnv = process.env): boolean {
  // Never in production — config/env.ts exits at boot rather than allow it, so this is a
  // second lock on the same door.
  if (source.NODE_ENV === "production") return false;
  return flag(source.AUTH_DISABLED);
}

/**
 * Who a request is when verification is off. Without this, `npm run dev` against an empty
 * database would bounce you to a login page you have no account for — so the escape hatch
 * hands you an admin instead of handing you nothing.
 */
const DEV_USER: SessionUser = {
  sub: "0",
  email: "dev@localhost",
  name: "Local dev",
  roles: ["admin"],
};

/**
 * The global session guard, registered on the ROOT instance from buildApp() so it covers
 * every route registered afterwards.
 *
 * The app now issues its own sessions — see lib/session.ts. The token arrives either in
 * the httpOnly session cookie (browsers) or as `Authorization: Bearer` (scripts and tests,
 * which read it off the Set-Cookie that /login returns).
 */
export function registerAuth(app: FastifyInstance): void {
  const disabled = resolveAuthDisabled();

  if (disabled) {
    app.log.warn(
      "AUTH IS DISABLED — every endpoint is open and every request is treated as an admin. " +
        "Unset AUTH_DISABLED to require a real sign-in. (Production refuses to boot with it set.)"
    );
  }

  app.decorate("authDisabled", disabled);

  app.addHook("onRequest", async (req: FastifyRequest) => {
    if (disabled) {
      req.user = DEV_USER;
      return;
    }
    if (isPublic(req.url)) return;

    const token = readCookie(req.headers.cookie, SESSION_COOKIE()) ?? bearerToken(req.headers.authorization);
    if (!token) throw new Unauthorized("Not signed in");

    // One indexed lookup. A revoked session, an expired one and a disabled account all
    // resolve to nothing here — which is the point of sessions over a JWT: they end when
    // we say they end, not when the token says so.
    const user = await resolveSession(token);
    if (!user) throw new Unauthorized("Your session has expired — sign in again");

    req.user = user;
  });
}
