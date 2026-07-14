"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import type { AuthUser } from "@extensions/contract";
import { api, ApiError } from "@/lib/api/client";
import { setUnauthorizedHandler } from "@/lib/auth/session";

/**
 * Who is signed in.
 *
 * The session itself is an httpOnly cookie, so the browser cannot read it — which means
 * the only way to answer "am I signed in?" is to ask the server. That is what `me()` is
 * for, and why there is a loading state at all: on first paint we genuinely do not know.
 */

interface AuthState {
  user: AuthUser | null;
  /** True until the first /me answers. Render nothing decisive while it is. */
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = React.createContext<AuthState | null>(null);

export function useAuth(): AuthState {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname() ?? "/";
  const queryClient = useQueryClient();

  const [user, setUser] = React.useState<AuthUser | null>(null);
  const [loading, setLoading] = React.useState(true);

  // `pathname` is read inside the handler but must not re-register it on every navigation,
  // so keep it in a ref. Otherwise the effect below churns on each route change.
  const pathnameRef = React.useRef(pathname);
  pathnameRef.current = pathname;

  // Ask the server once, on mount. A 401 here is the ordinary "not signed in" answer,
  // not an error worth surfacing.
  React.useEffect(() => {
    let cancelled = false;
    api.auth
      .me()
      .then((u) => {
        if (!cancelled) setUser(u);
      })
      .catch(() => {
        if (!cancelled) setUser(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Any 401 from any request lands here (lib/api/client.ts calls it). The session is gone,
  // so drop the user and send them to sign in — remembering where they were, so they land
  // back on the page they actually wanted rather than the dashboard.
  React.useEffect(() => {
    setUnauthorizedHandler(() => {
      setUser(null);
      const at = pathnameRef.current;
      if (at === "/login") return;
      const next = at && at !== "/" ? `?next=${encodeURIComponent(at)}` : "";
      router.replace(`/login${next}`);
    });
    return () => setUnauthorizedHandler(null);
  }, [router]);

  const signIn = React.useCallback(
    async (email: string, password: string) => {
      const u = await api.auth.login({ email, password });
      setUser(u);
      setLoading(false);
    },
    []
  );

  const signOut = React.useCallback(async () => {
    try {
      await api.auth.logout();
    } catch {
      // The server may already consider the session dead. Signing out must succeed locally
      // regardless — refusing to log someone out because the logout call failed is absurd.
    }
    setUser(null);
    // Everything cached was fetched as *that* user. Leaving it in place would show the next
    // person the last one's data until each query happened to refetch.
    queryClient.clear();
    router.replace("/login");
  }, [queryClient, router]);

  const value = React.useMemo<AuthState>(
    () => ({ user, loading, signIn, signOut }),
    [user, loading, signIn, signOut]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** True when an error is the API's "not signed in" answer. */
export const isUnauthorized = (err: unknown): boolean => err instanceof ApiError && err.status === 401;
