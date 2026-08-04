"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "./auth-provider";
import { HOME_FOR_REVIEWER, mayOpenPage } from "@/lib/auth/access";

/**
 * Gate for everything under (app) — first "are you signed in", then "may your role open
 * this page".
 *
 * This is a *client* guard, and deliberately so: the session cookie is set by the API,
 * which is a different origin from Next, so Next middleware cannot see it and cannot make
 * this decision on the server. The real enforcement is not here at all — it is the API's
 * onRequest hook, which 401s every request without a session and 403s every request the
 * caller's role does not allow. This only decides what to paint. Bypassing it in devtools
 * gets you an empty shell that can't load a single row.
 */
export function AuthGuard({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();
  const pathname = usePathname() ?? "/";

  const allowed = !user || mayOpenPage(user.roles, pathname);

  React.useEffect(() => {
    if (loading) return;
    if (!user) {
      const next = pathname && pathname !== "/" ? `?next=${encodeURIComponent(pathname)}` : "";
      router.replace(`/login${next}`);
      return;
    }
    // Signed in, but this page is not theirs — a reviewer who typed /database, or followed
    // a stale link. Send them home rather than to /login: they ARE signed in, and bouncing
    // to a login form they'd sail straight through would read as a broken app.
    if (!allowed) router.replace(HOME_FOR_REVIEWER);
  }, [loading, user, allowed, pathname, router]);

  // Nothing is known yet. Show a quiet placeholder rather than the app (which would flash
  // an empty dashboard) or the login page (which would flash for people already signed in).
  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center" role="status" aria-live="polite">
        <span className="sr-only">Checking your session…</span>
        <span className="h-5 w-5 animate-spin rounded-full border-2 border-muted border-t-primary" aria-hidden />
      </div>
    );
  }

  // Signed out: the redirect above is already in flight; render nothing in the meantime.
  if (!user) return null;

  // Same, for a page this role cannot open. Painting it for one frame would fire its
  // queries and fill the console with 403s on the way out.
  if (!allowed) return null;

  return <>{children}</>;
}
