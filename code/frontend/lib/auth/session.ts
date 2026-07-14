/**
 * The seam between the API client and the auth UI.
 *
 * There is no token here any more, and that is the point. NameSync used to read a JWT the
 * host site had left in localStorage and attach it as a bearer header — which meant any
 * script on the page could read the session. The session now lives in an httpOnly cookie
 * the browser attaches by itself: unreadable to script, and revocable by the server.
 *
 * So the only thing the client layer still needs from the auth layer is somewhere to
 * report a 401 — which is what this is. The AuthProvider registers a handler that sends
 * the user to /login; nothing else in the app has to know about that.
 */

export type UnauthorizedHandler = () => void;

let handler: UnauthorizedHandler | null = null;

/** Registered once, by the AuthProvider. */
export function setUnauthorizedHandler(next: UnauthorizedHandler | null): void {
  handler = next;
}

/**
 * Called by the API client whenever the server answers 401 — the session expired, was
 * revoked, or the account was disabled. A no-op before the provider mounts (and on the
 * server), which is correct: there is no one to redirect yet.
 */
export function notifyUnauthorized(): void {
  handler?.();
}
