/**
 * Minimal cookie read/write.
 *
 * The app sets exactly one cookie (the session) and reads exactly one, so @fastify/cookie
 * would be a dependency earning its keep on a single header. This is that header.
 */

export interface CookieOptions {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "lax" | "strict" | "none";
  path?: string;
  domain?: string;
  /** Seconds. 0 expires the cookie immediately — that's how a cookie is cleared. */
  maxAge?: number;
}

/** Pull one cookie out of a `Cookie:` request header. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw; // not percent-encoded — take it as-is rather than dropping the session
    }
  }
  return undefined;
}

/** Build a `Set-Cookie` value. */
export function serializeCookie(name: string, value: string, opts: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];

  parts.push(`Path=${opts.path ?? "/"}`);
  if (opts.domain) parts.push(`Domain=${opts.domain}`);
  if (opts.maxAge !== undefined) {
    const maxAge = Math.max(0, Math.floor(opts.maxAge));
    parts.push(`Max-Age=${maxAge}`);
    // Max-Age alone is ignored by some older clients; Expires is the belt to its braces.
    parts.push(`Expires=${new Date(Date.now() + maxAge * 1000).toUTCString()}`);
  }
  if (opts.httpOnly) parts.push("HttpOnly");
  if (opts.secure) parts.push("Secure");
  if (opts.sameSite) {
    parts.push(`SameSite=${opts.sameSite[0].toUpperCase()}${opts.sameSite.slice(1)}`);
  }

  return parts.join("; ");
}
