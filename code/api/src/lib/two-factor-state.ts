import type { TwoFactorKnownMethod } from "@extensions/contract";

/**
 * What we know about each user's second factor, so the settings page can SHOW it without
 * asking for a password.
 *
 * Reading the live flag means calling Center, which needs a Center JWT — and the only one this
 * app ever holds lives in the re-auth window (lib/reauth-window.ts) for a few minutes after a
 * password confirmation. So "is my 2FA on?" used to be answerable only by re-authenticating,
 * which is a strange toll to pay for a question with a one-word answer.
 *
 * This remembers the answer instead. It is written at the two moments the real state is
 * already in hand, at no extra cost:
 *
 *   - sign-in — Center demanding a second factor IS the state. A login that completed on a
 *     password alone means there is no second factor; one that needed a code means there is,
 *     and the challenge names which. No extra Center call. (services/center-auth.service.ts)
 *   - any 2FA action — reauth, enable, disable all return the authoritative method already.
 *     (routes/auth.route.ts)
 *
 * ── What this is not ──────────────────────────────────────────────────────────
 * It is a cache of a fact, never an authority: nothing reads it to decide whether to demand a
 * factor, and it unlocks nothing. Center remains the only place 2FA is enforced, and the
 * re-auth window is still the only way to CHANGE anything. The worst a wrong entry can do is
 * mislabel a card, which the next sign-in corrects.
 *
 * In process memory, like the window and the login throttle — deliberately, since it holds
 * nothing worth persisting and a restart merely returns the page to "unknown", i.e. to how it
 * behaved before this existed. Behind several API replicas each one learns the state from the
 * logins it happens to serve; the honest fallback covers the rest.
 */

export interface KnownTwoFactorState {
  /** Never `unknown` — an absent entry is what "unknown" means. */
  method: Exclude<TwoFactorKnownMethod, "unknown">;
  /** When this reading was taken, epoch ms. */
  checkedAt: number;
}

const states = new Map<string, KnownTwoFactorState>();

/**
 * The cap exists so a long-lived process can't accumulate an entry per user forever. Well past
 * any real user count for an internal tool, and the eviction below is oldest-first rather than
 * arbitrary, so the entries that survive are the ones someone is most likely still looking at.
 */
const MAX_ENTRIES = 5_000;

function evictOldest(): void {
  if (states.size < MAX_ENTRIES) return;
  let oldestKey: string | undefined;
  let oldestAt = Infinity;
  for (const [key, state] of states) {
    if (state.checkedAt < oldestAt) {
      oldestAt = state.checkedAt;
      oldestKey = key;
    }
  }
  if (oldestKey) states.delete(oldestKey);
}

/** Record what we just learned about this user's second factor. */
export function rememberTwoFactorState(
  userId: string,
  method: Exclude<TwoFactorKnownMethod, "unknown">
): void {
  evictOldest();
  states.set(userId, { method, checkedAt: Date.now() });
}

/** What we last knew, or undefined when this process has never learned it. */
export function getKnownTwoFactorState(userId: string): KnownTwoFactorState | undefined {
  return states.get(userId);
}

/** Test seam: drop everything, so one test's sign-in can't colour the next one's reading. */
export function resetTwoFactorStates(): void {
  states.clear();
}
