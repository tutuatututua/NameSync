import { hasFullAccess, isReviewerOnly } from "@extensions/contract";

/**
 * What a role may OPEN, in the browser.
 *
 * The mirror of api/src/lib/roles.ts, and strictly the cosmetic half: this decides which
 * nav items to paint and which URLs to bounce. It is not the boundary. A reviewer who edits
 * this out in devtools reaches pages whose every request the API refuses with a 403 — the
 * same relationship AuthGuard already has with the session cookie.
 *
 * Both lists exist because they answer different questions ("may I call this endpoint?" vs
 * "may I open this page?") and neither derives from the other. Widening one without the
 * other gives you either a dead-end page or an invisible-but-reachable one — so change them
 * together.
 */

/**
 * The pages a `reviewer` may open: the Network hub, the company and roster pages its tabs
 * link into, and a past run's results. Everything else — /uploads, /database — is theirs to
 * be redirected away from.
 */
const REVIEWER_PAGES: RegExp[] = [
  /^\/$/,
  /^\/companies\/[^/]+\/?$/,
  /^\/uploaders\/[^/]+\/?$/,
  /^\/comparisons\/[^/]+\/?$/,
];

/** May an account with these roles open this path? */
export function mayOpenPage(roles: readonly string[], pathname: string): boolean {
  if (hasFullAccess(roles)) return true;
  if (isReviewerOnly(roles)) return REVIEWER_PAGES.some((re) => re.test(pathname));
  // Neither full access nor reviewer: the account holds no role this app understands. Show
  // nothing rather than guessing — the API will refuse it everything anyway.
  return false;
}

/** Where someone gets sent when they land somewhere their role cannot open. */
export const HOME_FOR_REVIEWER = "/";
