"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ThresholdSchema } from "@extensions/contract";

/**
 * The Network workspace's bar, held in the URL.
 *
 * ── Why the URL and not a context ──
 *
 * Three things fall out of it and all three are the point: a tuned workspace survives a reload, it
 * can be sent to someone ("look at it at 0.62"), and — the one a React context could not give — the
 * bar travels through a LINK. The Network page's rows link out to a company page and a roster page,
 * which are separate routes with their own data; `withThreshold` puts the bar on those hrefs, and
 * `useThreshold` reads it back on the far side. A context would have been lost on navigation, and
 * the drill-down would have quietly reverted to the matchers' verdicts while the tiles that linked
 * to it were still tuned — the exact contradiction this feature exists to remove.
 *
 * Parsed through the contract's own schema, the same one the API validates with, so a hand-edited
 * `?threshold=banana` or `?threshold=8` falls back to the default bar rather than being sent to the
 * server to be rejected.
 *
 * ── Why the workspace opens AT a bar, and how "no bar" is still reachable ──
 *
 * The server's default is, and stays, the matchers' own verdicts: `?threshold=` absent on the API
 * means no re-grading (see the contract's `threshold.ts`). This is the CLIENT's default, and it is a
 * different question — not "what does a stored row mean" but "what should a reader be looking at
 * when they arrive". Pooled across matchers of varying strictness, that is 80%.
 *
 * Because absent now means 80% on this side, "the matchers' own verdicts" needs a spelling of its
 * own in the URL, or the reset would write an empty parameter and read back as the default. That
 * spelling is `?threshold=off`. It never reaches the API — a null threshold is simply omitted from
 * the request, which is exactly what the API's own default already is.
 */

/** Where the workspace opens: every count read at 80%, on arrival and without asking. Client-side
 *  only — it changes what a reader is shown first, never what a stored row means. */
export const DEFAULT_THRESHOLD = 0.8;

/** "The matchers' own verdicts", as it appears in the URL. Needed because an absent parameter is
 *  the default bar now, so opting out has to be said out loud. */
const OFF = "off";

/** The parsed bar, or null for "the matchers' own verdicts". An absent or unparseable parameter is
 *  the default bar; only an explicit `off` turns the re-grading off. */
export function readThreshold(raw: string | null): number | null {
  if (raw === null) return DEFAULT_THRESHOLD;
  if (raw === OFF) return null;
  const parsed = ThresholdSchema.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT_THRESHOLD;
}

/**
 * The bar as a query-string value, or null when nothing needs to go on the URL.
 *
 * Three inputs, and `null` and `undefined` are NOT the same one:
 *   · a number  → itself, unless it is the default, which is what an absent parameter already means
 *   · `null`    → `off`, an explicit request for the matchers' own verdicts
 *   · undefined → nothing, from a surface with no bar of its own (the run page's provenance strip).
 *     It must not become `off`: that would be a page which never had an opinion about the bar
 *     opting the reader OUT of the workspace default on their way into the workspace.
 */
export function thresholdParam(threshold: number | null | undefined): string | null {
  if (threshold === undefined) return null;
  if (threshold === null) return OFF;
  if (threshold === DEFAULT_THRESHOLD) return null;
  return String(threshold);
}

/** The same href with the current bar attached, so a click does not drop the tuning. Returns the
 *  href untouched at the default bar — no `?threshold=` on a default read, ever. */
export function withThreshold(href: string, threshold: number | null | undefined): string {
  const param = thresholdParam(threshold);
  if (param === null) return href;
  return `${href}${href.includes("?") ? "&" : "?"}threshold=${param}`;
}

/**
 * Read the bar, and (on the page that owns the control) move it.
 *
 * `setThreshold` uses `replace`, not `push`: dragging a slider is one act of looking, not twenty
 * navigations, and the back button should return to wherever the reader came FROM rather than
 * walking them back through every position of the handle. `scroll: false` keeps the page still
 * under it — without it every step of a drag would jump the reader to the top.
 */
export function useThreshold(): [number | null, (next: number | null) => void] {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const threshold = readThreshold(search.get("threshold"));

  const setThreshold = React.useCallback(
    (next: number | null) => {
      const sp = new URLSearchParams(search.toString());
      const param = thresholdParam(next);
      if (param === null) sp.delete("threshold");
      else sp.set("threshold", param);
      const q = sp.toString();
      router.replace(q ? `${pathname}?${q}` : pathname, { scroll: false });
    },
    [pathname, router, search]
  );

  return [threshold, setThreshold];
}
