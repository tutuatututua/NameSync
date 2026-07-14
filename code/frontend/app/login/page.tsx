"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/components/auth-provider";
import { ApiError } from "@/lib/api/client";
import { ThemeToggle } from "@/components/theme-toggle";

/**
 * /login — the sign-in page.
 *
 * It lives outside the (app) route group on purpose: that group's layout is the sidebar +
 * top bar, which is chrome for someone who is already in. This page has neither.
 *
 * The form posts to /api/auth/login, which answers with an httpOnly Set-Cookie. No token
 * is stored here, because none is ever handed to the page.
 */
export default function LoginPage() {
  return (
    // useSearchParams() forces this subtree to render on the client; without a Suspense
    // boundary Next refuses to prerender the route at build time.
    <React.Suspense fallback={<LoginShell>{null}</LoginShell>}>
      <LoginForm />
    </React.Suspense>
  );
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, loading, signIn } = useAuth();

  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [showPassword, setShowPassword] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  // Where to go once we're in. Only ever a path on this site: an open redirect is what you
  // get if you let ?next= be an absolute URL, and a login page is precisely where an
  // attacker would want one.
  const rawNext = searchParams.get("next");
  const next = rawNext && rawNext.startsWith("/") && !rawNext.startsWith("//") ? rawNext : "/";

  // Already signed in (came back to /login by hand, or the session outlived the tab).
  React.useEffect(() => {
    if (!loading && user) router.replace(next);
  }, [loading, user, next, router]);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await signIn(email, password);
      router.replace(next);
    } catch (err) {
      // The API says "Incorrect email or password" for a wrong password AND for an email
      // that has no account — deliberately, so this page can't be used to discover who has
      // one. Show what it said; don't try to be more helpful than that.
      setError(
        err instanceof ApiError ? err.message : "Something went wrong signing you in. Please try again."
      );
      setPassword("");
      setSubmitting(false);
    }
    // No setSubmitting(false) on success: the redirect is in flight and the button should
    // stay busy until this page is gone, not flicker back to "Sign in".
  }

  return (
    <LoginShell>
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <div className="space-y-1.5">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            autoFocus
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            // The error is about the credentials as a pair, so it is described by both fields.
            aria-describedby={error ? "login-error" : undefined}
            aria-invalid={error ? true : undefined}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="password">Password</Label>
          <div className="relative">
            <Input
              id="password"
              name="password"
              type={showPassword ? "text" : "password"}
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="pr-10"
              aria-describedby={error ? "login-error" : undefined}
              aria-invalid={error ? true : undefined}
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              // A password you cannot see is a password you mistype; the toggle is the
              // cheapest fix for the most common cause of a "failed" login.
              aria-label={showPassword ? "Hide password" : "Show password"}
              aria-pressed={showPassword}
              className="absolute right-1 top-1/2 -translate-y-1/2 rounded-md p-2 text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </div>

        {error && (
          // role="alert" so a screen reader announces the failure instead of leaving the
          // user tabbing back into a form that silently rejected them.
          <p
            id="login-error"
            role="alert"
            className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </p>
        )}

        <Button type="submit" className="w-full" disabled={submitting}>
          {submitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Signing in…
            </>
          ) : (
            "Sign in"
          )}
        </Button>
      </form>

      <p className="mt-6 text-center text-xs text-muted-foreground">
        Sign in with your PromptX account.
      </p>
    </LoginShell>
  );
}

/** The page around the form — shared with the Suspense fallback so nothing shifts. */
function LoginShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="relative flex min-h-screen items-center justify-center bg-background px-4 py-12">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>

      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <span className="mb-3 h-10 w-10 rounded-xl bg-gradient-brand shadow-xs" aria-hidden />
          <h1 className="font-display text-2xl font-semibold tracking-tight">Sign in to NameSync</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">Name matching, synced.</p>
        </div>

        <div className="rounded-xl border bg-card p-6 shadow-xs">{children}</div>
      </div>
    </main>
  );
}
