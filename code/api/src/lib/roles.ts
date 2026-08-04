import { hasFullAccess, isReviewerOnly } from "@extensions/contract";

/**
 * Who may call what.
 *
 * Until now `roles` was carried around but only ever consulted in one place (POST
 * /api/auth/users). This is the actual authorisation layer, and it exists because the
 * `reviewer` role has to be a real boundary rather than a hidden nav item: a reviewer who
 * types /api/db/sql into a terminal must be refused by the server, not merely un-linked
 * in the UI.
 *
 * ── Why an allowlist, and not "reviewers may only send GET" ──────────────────────────
 * Two independent reasons, both load-bearing:
 *
 *   1. Not every read is a GET. `POST /api/db/sql` and `POST /api/db/tables/:table/query`
 *      are reads with a request body. A method rule would wave them through — handing a
 *      reviewer the SQL console, which is the single most powerful read in the app.
 *   2. Not every GET is theirs. `GET /api/db/tables` and `GET /api/upload-sessions` are the
 *      Data and Uploads pages, which a reviewer is not supposed to reach at all.
 *
 * So the rule is default-deny with an explicit list of what the reviewer's four pages
 * actually call. A route added later is denied to reviewers until someone adds it here on
 * purpose — which is the failure direction to want.
 */

/** One allowlist entry: an HTTP method plus an exact path matcher. */
interface Allowed {
  method: string;
  path: RegExp;
}

/**
 * Everything a `reviewer` may call — derived from the pages they can open (`/`,
 * `/companies/[name]`, `/uploaders/[name]`, `/comparisons/[id]`) and nothing else.
 *
 * Anchored on both ends (`^…$`) so a prefix can never widen a rule: an unanchored
 * `/api/network/` would also admit anything mounted under it later.
 */
const REVIEWER_ALLOWED: Allowed[] = [
  // Their own account. Signing out and changing your own password are writes, but they act
  // on the reviewer themselves rather than on any data — refusing them would mean an account
  // that cannot log out or rotate its own password.
  { method: "GET", path: /^\/api\/auth\/me$/ },
  { method: "POST", path: /^\/api\/auth\/logout$/ },
  { method: "POST", path: /^\/api\/auth\/change-password$/ },

  // The Network workspace — the whole point of the role. All five are reads.
  { method: "GET", path: /^\/api\/network\/(overview|grading|uploaders|uploader|search)$/ },

  // The run list on the Network page (RecentRuns), and viewing one run's stored results.
  // `[^/]+` is the run id; the suffix alternation is what keeps this from also matching
  // siblings like /api/comparisons/duplicate or /api/comparisons/company-data/all.
  { method: "GET", path: /^\/api\/comparisons$/ },
  { method: "GET", path: /^\/api\/comparisons\/[^/]+\/(progress|results|rows)$/ },

  // The import-type pick-list. Not a page of its own — RunRows reads it to label a row's
  // source, so a reviewer looking at a run needs it or the labels come out blank.
  { method: "GET", path: /^\/api\/upload-sources$/ },
];

/** Strip the query string; the allowlist matches on path only. */
const pathOf = (url: string): string => url.split("?")[0];

/**
 * May an account with these roles call this endpoint?
 *
 * Full-access roles (`user`, `admin`) are unrestricted here — the only finer-grained check
 * in the app is the admin gate on user creation, which stays where it is in auth.route.ts.
 *
 * An account holding NEITHER a full-access role nor `reviewer` is refused everything. That
 * is deliberate: a typo'd or emptied `roles` array should lock the account out rather than
 * quietly fall through to full access.
 */
export function mayAccess(roles: readonly string[], method: string, url: string): boolean {
  if (hasFullAccess(roles)) return true;

  const path = pathOf(url);
  const wanted = method.toUpperCase();
  if (isReviewerOnly(roles)) {
    return REVIEWER_ALLOWED.some((rule) => rule.method === wanted && rule.path.test(path));
  }
  return false;
}

/**
 * The message a refused request gets. It names the role rather than the endpoint, because
 * "you are a reviewer" is the useful half — the reviewer did not choose to call this, some
 * component did, and telling them which path was blocked helps nobody.
 */
export const FORBIDDEN_MESSAGE =
  "Your account has read-only access to the Network page.";
