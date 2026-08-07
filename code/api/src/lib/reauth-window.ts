/**
 * The re-authentication window — a short-lived "you just proved your password" ticket that
 * unlocks the 2FA management calls.
 *
 * Managing 2FA means calling Center's own APIs, which need a live Center JWT. Network Intel
 * throws that token away right after login (lib/session.ts), on purpose, so it has none to
 * reuse. Rather than start storing Center credentials, the settings flow re-authenticates the
 * user against Center for this one sensitive action and parks the resulting token HERE — in
 * process memory, for a few minutes, never in the database and never sent to the browser.
 *
 * Keyed by the caller's own session-token hash, so a window one browser opened cannot be used
 * by another. Like the login throttle, this map is per-process: behind several API replicas
 * the follow-up calls of one enrolment must land on the instance that opened the window. Fine
 * for a single-instance deploy; a scaled one would move this to a shared store.
 */

/** The Center identity the 2FA proxy acts as, captured once when the window opens. */
export interface CenterAccount {
  /** CenterProfile.username — what the TOTP APIs key on, and the `email`/`userID` sendcode/verifycode use. */
  username: string;
  /** CenterProfile.id — the `username` field Center's SMS enrolment sendcode expects. Falls back to username. */
  id: string;
}

export interface ReauthWindow {
  /** The throwaway Center JWT, used to call Center's 2FA endpoints. Never leaves this process. */
  centerToken: string;
  /** Who the proxy is acting as at Center. */
  account: CenterAccount;
  /** The TOTP secret from the most recent `generate-totp`, held so `enable` can verify against
   *  it without trusting the browser to echo it back. Undefined until authenticator setup starts. */
  pendingSecret?: string;
  /** The phone + reference from the most recent SMS `send-code`, held so `sms/enable` can verify
   *  against them. Undefined until SMS enrolment starts. */
  pendingSms?: { ref: string; phoneCountry: string; phoneNumber: string };
  /** Epoch ms after which the window is dead. */
  expiresAt: number;
}

/** How long one password confirmation stays good for — long enough to scan a QR and type a code. */
export const REAUTH_TTL_MS = 10 * 60 * 1000;

const windows = new Map<string, ReauthWindow>();

/** Opportunistic sweep so the map can't grow without bound on a long-lived process. */
function prune(): void {
  if (windows.size < 500) return;
  const now = Date.now();
  for (const [key, w] of windows) if (now > w.expiresAt) windows.delete(key);
}

/** Open (or replace) the window for a session, starting the clock fresh. */
export function openReauthWindow(key: string, centerToken: string, account: CenterAccount): void {
  prune();
  windows.set(key, { centerToken, account, expiresAt: Date.now() + REAUTH_TTL_MS });
}

/** The live window for a session, or undefined if there is none or it has expired (and is swept). */
export function getReauthWindow(key: string): ReauthWindow | undefined {
  const w = windows.get(key);
  if (!w) return undefined;
  if (Date.now() > w.expiresAt) {
    windows.delete(key);
    return undefined;
  }
  return w;
}

/** Remember the secret an authenticator enrolment is mid-way through verifying. No-op if the window is gone. */
export function setPendingSecret(key: string, secret: string): void {
  const w = getReauthWindow(key);
  if (w) w.pendingSecret = secret;
}

/** Remember the phone + reference an SMS enrolment is mid-way through verifying. No-op if the window is gone. */
export function setPendingSms(
  key: string,
  pending: { ref: string; phoneCountry: string; phoneNumber: string }
): void {
  const w = getReauthWindow(key);
  if (w) w.pendingSms = pending;
}

/** Close the window — on completion, on cancel, or on sign-out. Idempotent. */
export function closeReauthWindow(key: string): void {
  windows.delete(key);
}

/** Test seam: drop every window so one test's re-auth can't leak into the next. */
export function resetReauthWindows(): void {
  windows.clear();
}
