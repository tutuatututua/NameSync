import { createHash, randomBytes } from "node:crypto";
import type { FastifyReply } from "fastify";
import { env, isProduction } from "../config/env";
import { serializeCookie, type CookieOptions } from "./cookies";

/**
 * Session tokens — what replaced the JWT.
 *
 * A JWT is a bearer claim the server can only ever *verify*: it cannot be withdrawn, so a
 * stolen one stays valid until it expires, and "sign out" is a lie the client tells itself.
 * NameSync now issues its own sessions instead, and they are just rows (auth_session), so
 * signing out — or disabling an account — takes effect on the very next request.
 *
 * The token is 32 random bytes. It is handed to the browser once and never stored: the
 * database keeps only its SHA-256, so a dump of auth_session yields nothing replayable.
 * A plain hash (not scrypt) is right here and not a shortcut — the input is 256 bits of
 * entropy, so there is no dictionary to run against it, and the lookup must be fast.
 */

export interface SessionUser {
  /** The app_user id, as a string (bigint). Kept as `sub` on the request for continuity. */
  sub: string;
  email: string;
  name?: string;
  roles: string[];
}

/** A fresh, unguessable session token — the only time the plaintext exists. */
export const newSessionToken = (): string => randomBytes(32).toString("base64url");

/** What we actually store and look up by. */
export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

export const sessionTtlMs = (): number => env.SESSION_TTL_HOURS * 60 * 60 * 1000;

export const sessionExpiry = (): Date => new Date(Date.now() + sessionTtlMs());

/**
 * How the session cookie is written.
 *
 * `httpOnly` is the whole point: script cannot read the token, so an XSS bug cannot walk
 * off with the session the way it could with a JWT parked in localStorage.
 *
 * SameSite defaults to `lax`, which is correct whenever the site and the API share a
 * registrable domain — including localhost:3000 -> localhost:4000, since the port is not
 * part of the "site". Only a genuinely cross-site deployment needs `none`, and the browser
 * then insists on Secure (config/env.ts refuses that combination without it).
 */
function cookieOptions(maxAgeSeconds: number): CookieOptions {
  return {
    httpOnly: true,
    secure: env.AUTH_COOKIE_SECURE ?? isProduction,
    sameSite: env.AUTH_COOKIE_SAMESITE,
    domain: env.AUTH_COOKIE_DOMAIN,
    path: "/",
    maxAge: maxAgeSeconds,
  };
}

export const SESSION_COOKIE = (): string => env.AUTH_COOKIE_NAME;

export function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.header(
    "set-cookie",
    serializeCookie(SESSION_COOKIE(), token, cookieOptions(Math.floor(sessionTtlMs() / 1000)))
  );
}

/** Same name/path/domain as when it was set, or the browser keeps the old one. */
export function clearSessionCookie(reply: FastifyReply): void {
  reply.header("set-cookie", serializeCookie(SESSION_COOKIE(), "", cookieOptions(0)));
}

/** Pull the token out of `Authorization: Bearer <token>`. */
export function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : undefined;
}
