"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import type { TwoFactorMethod } from "@extensions/contract";
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
 * The real sign-in is Center: the form posts email+password to the API, which forwards them
 * to Center and — on success — answers with an httpOnly Set-Cookie. No token is stored here,
 * because none is ever handed to the page. If Center wants a second factor, the API says so
 * and the form asks for the code, then submits again.
 *
 * The local path (`NEXT_PUBLIC_AUTH_MODE=local`) now carries the same two-step: the password
 * is only the first factor, and Network Intel then emails a one-time code the form asks for — the
 * exact shape as Center's email 2FA, just minted by Network Intel itself. So both real sign-in
 * paths verify a second factor before a session is issued.
 */

/**
 * Which sign-in the form drives:
 *  - `center` (default) — forward to Center; Center owns the second factor.
 *  - `local`            — Network Intel's own login: password, then a one-time code it emails.
 */
const AUTH_MODE = process.env.NEXT_PUBLIC_AUTH_MODE === "local" ? "local" : "center";

export default function LoginPage() {
  return (
    // useSearchParams() forces this subtree to render on the client; without a Suspense
    // boundary Next refuses to prerender the route at build time.
    <React.Suspense fallback={<LoginShell>{null}</LoginShell>}>
      <LoginForm />
    </React.Suspense>
  );
}

type Step = "credentials" | "2fa";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, loading, signInWithCenter, signInWithOtp } = useAuth();

  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [showPassword, setShowPassword] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  // The second-factor step: what Center asked for, and the code the user is entering. `ref`
  // is the email-OTP reference we must echo back; null for an authenticator app.
  const [step, setStep] = React.useState<Step>("credentials");
  const [twoFactor, setTwoFactor] = React.useState<{ method: TwoFactorMethod; ref: string | null } | null>(null);
  const [code, setCode] = React.useState("");

  // Where to go once we're in. Only ever a path on this site: an open redirect is what you
  // get if you let ?next= be an absolute URL, and a login page is precisely where an
  // attacker would want one.
  const rawNext = searchParams.get("next");
  const next = rawNext && rawNext.startsWith("/") && !rawNext.startsWith("//") ? rawNext : "/";

  // Already signed in (came back to /login by hand, or the session outlived the tab).
  React.useEffect(() => {
    if (!loading && user) router.replace(next);
  }, [loading, user, next, router]);

  /** Turn any thrown error into a message for the alert. */
  function showError(err: unknown) {
    setError(
      err instanceof ApiError ? err.message : "Something went wrong signing you in. Please try again."
    );
  }

  async function onSubmitCredentials(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      if (AUTH_MODE === "local") {
        // Password is only the first factor now: on success the API has emailed a code and
        // answered with a challenge, so move to the code step just like the Center path.
        const outcome = await signInWithOtp({ email, password });
        if (outcome.status === "signed-in") {
          router.replace(next);
          return;
        }
        setTwoFactor({ method: "email", ref: outcome.ref });
        setStep("2fa");
        setCode("");
        setSubmitting(false);
        return;
      }
      const outcome = await signInWithCenter({ email, password });
      if (outcome.status === "signed-in") {
        router.replace(next);
        return;
      }
      // Center wants a second factor — move to the code step. (For email, the API has
      // already asked Center to send the code.)
      setTwoFactor({ method: outcome.method, ref: outcome.ref });
      setStep("2fa");
      setCode("");
      setSubmitting(false);
    } catch (err) {
      // The API says "Incorrect email or password" for a wrong password AND for an unknown
      // account — deliberately, so this page can't be used to discover who has one. Show what
      // it said; don't try to be more helpful than that.
      showError(err);
      setPassword("");
      setSubmitting(false);
    }
  }

  async function onSubmit2fa(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!twoFactor) return;
    setError(null);
    setSubmitting(true);
    try {
      const outcome =
        AUTH_MODE === "local"
          ? await signInWithOtp({ email, password, code, ref: twoFactor.ref })
          : await signInWithCenter({
              email,
              password,
              code,
              method: twoFactor.method,
              ref: twoFactor.ref,
            });
      if (outcome.status === "signed-in") {
        router.replace(next);
        return; // stay busy through the redirect.
      }
      // A fresh challenge instead of a session shouldn't happen, but don't get stuck busy.
      setSubmitting(false);
    } catch (err) {
      showError(err);
      setCode("");
      setSubmitting(false);
    }
  }

  function backToCredentials() {
    setStep("credentials");
    setTwoFactor(null);
    setCode("");
    setError(null);
  }

  if (step === "2fa" && twoFactor) {
    return (
      <TwoFactorForm
        method={twoFactor.method}
        email={email}
        code={code}
        setCode={setCode}
        error={error}
        submitting={submitting}
        onSubmit={onSubmit2fa}
        onBack={backToCredentials}
      />
    );
  }

  return (
    <LoginShell>
      <form onSubmit={onSubmitCredentials} className="space-y-4" noValidate>
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

        {error && <LoginError>{error}</LoginError>}

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
        {AUTH_MODE === "local"
          ? "Enter your password — we'll email you a code to finish signing in."
          : "Sign in with your Center account."}
      </p>
    </LoginShell>
  );
}

/** The second-factor step. Same shell, a single code field, and a way back. */
function TwoFactorForm({
  method,
  email,
  code,
  setCode,
  error,
  submitting,
  onSubmit,
  onBack,
}: {
  method: TwoFactorMethod;
  email: string;
  code: string;
  setCode: (v: string) => void;
  error: string | null;
  submitting: boolean;
  onSubmit: (e: React.FormEvent<HTMLFormElement>) => void;
  onBack: () => void;
}) {
  const hint =
    method === "email"
      ? `Enter the code we emailed to ${email}.`
      : "Enter the 6-digit code from your authenticator app.";

  return (
    <LoginShell title="Two-step verification" subtitle={hint}>
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <div className="space-y-1.5">
          <Label htmlFor="code">Verification code</Label>
          <Input
            id="code"
            name="code"
            // A numeric one-time code: show the digit keypad on mobile and let the browser /
            // password managers autofill an SMS/authenticator code.
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="123456"
            aria-describedby={error ? "login-error" : undefined}
            aria-invalid={error ? true : undefined}
          />
        </div>

        {error && <LoginError>{error}</LoginError>}

        <Button type="submit" className="w-full" disabled={submitting}>
          {submitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Verifying…
            </>
          ) : (
            "Verify"
          )}
        </Button>

        <button
          type="button"
          onClick={onBack}
          className="w-full text-center text-xs text-muted-foreground underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:underline"
        >
          Use a different account
        </button>
      </form>
    </LoginShell>
  );
}

/** The credentials error, announced to screen readers. */
function LoginError({ children }: { children: React.ReactNode }) {
  return (
    // role="alert" so a screen reader announces the failure instead of leaving the user
    // tabbing back into a form that silently rejected them.
    <p
      id="login-error"
      role="alert"
      className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      {children}
    </p>
  );
}

/** The page around the form — shared with the Suspense fallback so nothing shifts. */
function LoginShell({
  children,
  title = "Sign in to Network Intel",
  subtitle = "Name matching, synced.",
}: {
  children: React.ReactNode;
  title?: string;
  subtitle?: string;
}) {
  return (
    <main className="relative flex min-h-screen items-center justify-center bg-background px-4 py-12">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>

      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <span className="mb-3 h-10 w-10 rounded-xl bg-gradient-brand shadow-xs" aria-hidden />
          <h1 className="font-display text-2xl font-semibold tracking-tight">{title}</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">{subtitle}</p>
        </div>

        <div className="rounded-xl border bg-card p-6 shadow-xs">{children}</div>
      </div>
    </main>
  );
}
