"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "./auth-provider";

/**
 * Gate for everything under (app).
 *
 * This is a *client* guard, and deliberately so: the session cookie is set by the API,
 * which is a different origin from Next, so Next middleware cannot see it and cannot make
 * this decision on the server. The real enforcement is not here at all — it is the API's
 * onRequest hook, which 401s every request without a session. This only decides what to
 * paint. Bypassing it in devtools gets you an empty shell that can't load a single row.
 */
export function AuthGuard({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();
  const pathname = usePathname() ?? "/";

  React.useEffect(() => {
    if (loading || user) return;
    const next = pathname && pathname !== "/" ? `?next=${encodeURIComponent(pathname)}` : "";
    router.replace(`/login${next}`);
  }, [loading, user, pathname, router]);

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

  return <>{children}</>;
}
