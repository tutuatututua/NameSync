"use client";

import * as React from "react";
import { QRCodeSVG } from "qrcode.react";
import { HelpCircle, Loader2, Mail, ShieldAlert, ShieldCheck, Smartphone } from "lucide-react";
import type { TwoFactorKnownMethod, TwoFactorMethod, TwoFactorMethodState } from "@extensions/contract";
import { api, ApiError } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { formatRelativeTime } from "@/lib/format";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";

/**
 * Two-factor authentication, managed here but owned by Center.
 *
 * Network Intel stores nothing about 2FA — every action proxies Center's own APIs (see
 * api/src/services/two-factor.service.ts). Because that needs a live Center token Network Intel
 * doesn't keep, CHANGING the setting is gated behind a re-auth: confirm the Center password once
 * and a short window opens. v1 enrols/removes the authenticator (TOTP) and SMS; an emailed code
 * is Center's own setting and can only be read here.
 *
 * ── Reading is not gated ──────────────────────────────────────────────────────
 * The card used to say nothing at all until the password was confirmed, so the commonest reason
 * to open this page — "am I actually protected?" — cost a password prompt, and anyone who
 * declined left no better informed than they arrived. The state is now shown on arrival, from
 * GET /2fa/known (what Center demanded at the last sign-in; see api/src/lib/two-factor-state.ts).
 * The password is still required for every change, which is the part that matters.
 */

/** null = not unlocked yet; the live Center state, once a password confirmation has read it. */
type MethodState = TwoFactorMethodState | null;

/** How each state presents: the badge, the panel tint, and what it means in plain words. */
const PRESENTATION: Record<
  TwoFactorKnownMethod,
  {
    label: string;
    badge: "success" | "warning" | "outline";
    tone: string;
    icon: React.ComponentType<{ className?: string }>;
    headline: string;
    detail: string;
  }
> = {
  totp: {
    label: "On",
    badge: "success",
    tone: "border-confidence-high/25 bg-confidence-high/10 text-confidence-high",
    icon: ShieldCheck,
    headline: "Your account is protected",
    detail: "Signing in needs a code from your authenticator app as well as your password.",
  },
  sms: {
    label: "On",
    badge: "success",
    tone: "border-confidence-high/25 bg-confidence-high/10 text-confidence-high",
    icon: Smartphone,
    headline: "Your account is protected",
    detail: "Signing in needs a code texted to your registered phone as well as your password.",
  },
  email: {
    label: "On",
    badge: "success",
    tone: "border-confidence-high/25 bg-confidence-high/10 text-confidence-high",
    icon: Mail,
    headline: "Your account is protected",
    detail:
      "Signing in needs a code emailed to you. Email codes are a Center setting — switch to an authenticator app below for a factor you can manage here.",
  },
  none: {
    label: "Off",
    badge: "warning",
    tone: "border-confidence-medium/25 bg-confidence-medium/10 text-confidence-medium",
    icon: ShieldAlert,
    headline: "Your account is not protected",
    detail: "Your password is the only thing standing between anyone who learns it and your account.",
  },
  unknown: {
    label: "Unknown",
    badge: "outline",
    tone: "border-border bg-muted/50 text-muted-foreground",
    icon: HelpCircle,
    headline: "We couldn't check your current setting",
    detail: "Confirm your password to read it from Center, or sign out and back in.",
  },
};

/** The name of the active factor, for the badge beside "On". */
const METHOD_NAME: Partial<Record<TwoFactorKnownMethod, string>> = {
  totp: "Authenticator app",
  sms: "SMS",
  email: "Email code",
};

export function TwoFactorCard() {
  /** What the last sign-in demanded. undefined while it is still being fetched. */
  const [known, setKnown] = React.useState<{ method: TwoFactorKnownMethod; checkedAt: string | null }>();
  const [method, setMethod] = React.useState<MethodState>(null);
  const [setupOpen, setSetupOpen] = React.useState(false);
  const [smsOpen, setSmsOpen] = React.useState(false);
  const [disabling, setDisabling] = React.useState(false);
  /**
   * Set when the user asks to turn 2FA on while the card is still locked, so the password prompt
   * hands straight over to enrolment instead of dropping them back on the card to press a second
   * button for the thing they already asked for.
   */
  const [afterUnlock, setAfterUnlock] = React.useState<"totp" | "sms" | null>(null);

  // The password confirmation is shown INLINE on the card (no separate "Manage" step). These
  // drive it. `challenge` is set when the account already has 2FA and Center wants the current
  // code first — the form then swaps the password field for a code field.
  const [password, setPassword] = React.useState("");
  const [challenge, setChallenge] = React.useState<{ method: TwoFactorMethod; ref: string | null } | null>(null);
  const [code, setCode] = React.useState("");
  const [reauthError, setReauthError] = React.useState<string | null>(null);
  const [reauthBusy, setReauthBusy] = React.useState(false);

  const unlocked = method !== null;

  // The state on arrival. A failure here is not worth a toast — the card falls back to
  // "unknown", which reads as "confirm your password to check", exactly as it did before.
  React.useEffect(() => {
    let cancelled = false;
    api.auth.twoFactor
      .known()
      .then((s) => {
        if (!cancelled) setKnown(s);
      })
      .catch(() => {
        if (!cancelled) setKnown({ method: "unknown", checkedAt: null });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Closing the re-auth window when the user leaves the page keeps a Center token from lingering
  // in server memory past the moment it is needed. Best-effort — logout also clears it server-side.
  React.useEffect(() => {
    return () => {
      void api.auth.twoFactor.end().catch(() => {});
    };
  }, []);

  /** Drop back to the (inline) password prompt with a clean slate. */
  const relock = React.useCallback((message?: string) => {
    setMethod(null);
    setSetupOpen(false);
    setSmsOpen(false);
    setPassword("");
    setChallenge(null);
    setCode("");
    setReauthError(null);
    setReauthBusy(false);
    if (message) toast.error(message);
  }, []);

  /** A 401 from any action means the window lapsed, not that the session died: re-lock and re-prompt. */
  const onActionError = React.useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) {
        relock(err.message || "Please confirm your password again.");
        return;
      }
      toast.error(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    },
    [relock]
  );

  /** Confirm the password (and current code, if challenged) to open the management window. */
  async function onReauth(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setReauthError(null);
    setReauthBusy(true);
    try {
      const result = await api.auth.twoFactor.reauth({
        password,
        code: challenge ? code : undefined,
        method: challenge?.method,
        ref: challenge?.ref ?? undefined,
      });
      if ("twoFactorRequired" in result) {
        // Account already protected — swap to the code field, then re-submit.
        setChallenge({ method: result.method, ref: result.ref });
        setCode("");
        setReauthBusy(false);
        return;
      }
      setMethod(result.method); // unlocked → the card now shows status + controls
    } catch (err) {
      setReauthError(err instanceof ApiError ? err.message : "Couldn't confirm your password. Please try again.");
      setCode("");
      setReauthBusy(false);
    }
  }

  async function onDisable() {
    setDisabling(true);
    try {
      const res = await api.auth.twoFactor.disable();
      applyMethod(res.method);
      toast.success("Two-factor authentication turned off.");
    } catch (err) {
      onActionError(err);
    } finally {
      setDisabling(false);
    }
  }

  const codeHint =
    challenge?.method === "totp"
      ? "Enter the current code from your authenticator app."
      : challenge?.method === "sms"
        ? "Enter the code we texted you."
        : "Enter the code we emailed you.";

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle>Two-factor authentication</CardTitle>
            <CardDescription>
              Require a second step when signing in. Protects your account even if your password is
              known. Managed through your Center account.
            </CardDescription>
          </div>
          {loading ? (
            <Skeleton className="h-5 w-16 shrink-0" />
          ) : (
            <Badge variant={view.badge} className="mt-0.5 shrink-0 gap-1 px-2 py-1 text-xs">
              <StatusIcon className="h-3.5 w-3.5" />
              {view.label}
            </Badge>
          )}
        </div>
      </CardHeader>

      {!unlocked ? (
        // Locked: the password confirmation lives right here on the card — no "Manage" click.
        <CardContent>
          <form onSubmit={onReauth} className="space-y-4" noValidate>
            {!challenge ? (
              <div className="space-y-1.5">
                <Label htmlFor="tfa-password">Confirm your password to view or change 2FA</Label>
                <Input
                  id="tfa-password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="max-w-sm"
                />
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label htmlFor="tfa-reauth-code">{codeHint}</Label>
                <Input
                  id="tfa-reauth-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoFocus
                  required
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="123456"
                  className="max-w-sm"
                />
              </div>
            )}

            {reauthError && (
              <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {reauthError}
              </p>
            )}

            <Button type="submit" disabled={reauthBusy}>
              {reauthBusy ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Confirming…
                </>
              ) : (
                "Confirm"
              )}
            </Button>
          </form>
        </CardContent>
      ) : (
        <>
          <CardContent>
            {method === "none" ? (
              <div className="flex items-center gap-2 text-sm">
                <ShieldOff className="h-4 w-4 text-muted-foreground" />
                <span className="text-muted-foreground">Two-factor authentication is off.</span>
              </div>
            ) : method === "totp" ? (
              <div className="flex items-center gap-2 text-sm">
                <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-500" />
                <span>On</span>
                <Badge variant="secondary">Authenticator app</Badge>
              </div>
            ) : (
              <div className="space-y-2 text-sm">
                <div className="flex items-center gap-2">
                  <Smartphone className="h-4 w-4 text-emerald-600 dark:text-emerald-500" />
                  <span>On</span>
                  <Badge variant="secondary">SMS</Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  Codes are texted to your registered phone. You can turn this off here.
                </p>
              </div>
            )}
          </CardContent>

          <CardFooter className="gap-2">
            {method === "none" ? (
              <>
                <Button onClick={() => setSetupOpen(true)}>Set up authenticator app</Button>
                <Button variant="outline" onClick={() => setSmsOpen(true)}>
                  Set up SMS
                </Button>
              </>
            ) : (
              <Button variant="destructive" onClick={onDisable} disabled={disabling}>
                {disabling ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Turning off…
                  </>
                ) : (
                  "Turn off"
                )}
              </Button>
            )}
          </CardFooter>
        </>
      )}

      <TotpSetupDialog
        open={setupOpen}
        onOpenChange={setSetupOpen}
        onEnabled={() => {
          applyMethod("totp");
          setSetupOpen(false);
          toast.success("Authenticator app enabled.");
        }}
        onActionError={onActionError}
      />

      <SmsSetupDialog
        open={smsOpen}
        onOpenChange={setSmsOpen}
        onEnabled={() => {
          applyMethod("sms");
          setSmsOpen(false);
          toast.success("SMS two-factor authentication enabled.");
        }}
        onActionError={onActionError}
      />
    </Card>
  );
}

/**
 * The authenticator enrolment wizard: fetch a secret + QR, let the user scan it (or copy the
 * key), then verify a code. Center activates TOTP on a correct code — there is no separate
 * "enable" step.
 */
function TotpSetupDialog({
  open,
  onOpenChange,
  onEnabled,
  onActionError,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onEnabled: () => void;
  onActionError: (err: unknown) => void;
}) {
  const [setup, setSetup] = React.useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [code, setCode] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [verifying, setVerifying] = React.useState(false);

  // Each time the dialog opens, ask Center for a fresh secret. A new secret per attempt means a
  // half-finished enrolment leaves nothing reusable behind.
  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setSetup(null);
    setCode("");
    setError(null);
    setLoading(true);
    api.auth.twoFactor
      .setupTotp()
      .then((s) => {
        if (!cancelled) setSetup(s);
      })
      .catch((err) => {
        if (!cancelled) {
          onOpenChange(false);
          onActionError(err);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, onOpenChange, onActionError]);

  async function onVerify(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setVerifying(true);
    try {
      const res = await api.auth.twoFactor.enableTotp({ code });
      if (res.enabled) {
        onEnabled();
        return;
      }
      setError("That code didn't match. Check your authenticator app and try again.");
      setCode("");
      setVerifying(false);
    } catch (err) {
      onActionError(err);
      setVerifying(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Set up authenticator app</DialogTitle>
          <DialogDescription>
            Scan the QR code with Google Authenticator (or any TOTP app), then enter the 6-digit code
            it shows.
          </DialogDescription>
        </DialogHeader>

        {loading || !setup ? (
          <div className="flex items-center justify-center py-10 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-col items-center gap-3">
              <div className="rounded-lg bg-white p-3">
                <QRCodeSVG value={setup.otpauthUrl} size={160} />
              </div>
              <div className="w-full text-center">
                <p className="text-xs text-muted-foreground">Can’t scan? Enter this key manually:</p>
                <code className="mt-1 block break-all rounded-md bg-muted px-2 py-1 text-xs">
                  {setup.secret}
                </code>
              </div>
            </div>

            <form onSubmit={onVerify} className="space-y-4" noValidate>
              <div className="space-y-1.5">
                <Label htmlFor="totp-code">Verification code</Label>
                <Input
                  id="totp-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoFocus
                  required
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="123456"
                />
              </div>

              {error && (
                <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {error}
                </p>
              )}

              <DialogFooter>
                <Button type="submit" disabled={verifying}>
                  {verifying ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Verifying…
                    </>
                  ) : (
                    "Turn on"
                  )}
                </Button>
              </DialogFooter>
            </form>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Drop the national trunk prefix, which is the "0" in 081-234-5678 but not part of the number
 * once a country code is in front of it: Thailand's +66 81 234 5678 is the SAME line, and
 * +66 081 234 5678 is not a number at all.
 *
 * It matters here because the failure is silent. Center answers a sendcode with a reference
 * whether or not the number it was handed can receive anything, so a leading 0 does not come
 * back as "bad number" — it comes back as a perfectly ordinary "enter the code we texted you",
 * for a text nobody sent. Anyone typing their own mobile number writes the 0.
 *
 * (Italy is the one common country that keeps its leading 0 in international form. This is why
 * the dialog SHOWS the number it is about to text rather than quietly rewriting the field.)
 */
const toInternational = (digits: string): string => digits.replace(/^0+/, "");

/**
 * The SMS enrolment wizard: enter a phone number → Center texts a code → verify it. Unlike the
 * authenticator, Center activates SMS only after the code checks out (the API flips the flag).
 */
function SmsSetupDialog({
  open,
  onOpenChange,
  onEnabled,
  onActionError,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onEnabled: () => void;
  onActionError: (err: unknown) => void;
}) {
  const [step, setStep] = React.useState<"phone" | "code">("phone");
  const [phoneCountry, setPhoneCountry] = React.useState("66");
  const [phoneNumber, setPhoneNumber] = React.useState("");
  const [code, setCode] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  // Fresh state each time the dialog opens.
  React.useEffect(() => {
    if (open) {
      setStep("phone");
      setPhoneCountry("66");
      setPhoneNumber("");
      setCode("");
      setError(null);
      setBusy(false);
    }
  }, [open]);

  /** Exactly what Center will be asked to text — shown before sending, and sent verbatim. */
  const sending = toInternational(phoneNumber.trim());

  async function onSendCode(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.auth.twoFactor.sendSmsCode({ phoneCountry: phoneCountry.trim(), phoneNumber: sending });
      setStep("code");
      setCode("");
      setBusy(false);
    } catch (err) {
      // A 400 here is Center's own message (e.g. number already in use) — show it inline; a 401
      // (window lapsed) is handled by the shared error path, which closes the dialog.
      if (err instanceof ApiError && err.status === 400) {
        setError(err.message);
        setBusy(false);
        return;
      }
      onOpenChange(false);
      onActionError(err);
    }
  }

  async function onVerify(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await api.auth.twoFactor.enableSms({ code });
      if (res.enabled) {
        onEnabled();
        return;
      }
      setError("That code didn't match. Check the text message and try again.");
      setCode("");
      setBusy(false);
    } catch (err) {
      onActionError(err);
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Set up SMS</DialogTitle>
          <DialogDescription>
            {step === "phone"
              ? "Enter your mobile number. We'll text you a code to confirm it."
              : `Enter the code we texted to +${phoneCountry}${sending}.`}
          </DialogDescription>
        </DialogHeader>

        {step === "phone" ? (
          <form onSubmit={onSendCode} className="space-y-4" noValidate>
            <div className="flex gap-2">
              <div className="w-24 space-y-1.5">
                <Label htmlFor="sms-country">Country</Label>
                <div className="flex items-center gap-1">
                  <span className="text-sm text-muted-foreground">+</span>
                  <Input
                    id="sms-country"
                    inputMode="numeric"
                    value={phoneCountry}
                    onChange={(e) => setPhoneCountry(e.target.value.replace(/\D/g, ""))}
                    required
                  />
                </div>
              </div>
              <div className="flex-1 space-y-1.5">
                <Label htmlFor="sms-number">Phone number</Label>
                <Input
                  id="sms-number"
                  inputMode="tel"
                  autoFocus
                  required
                  value={phoneNumber}
                  onChange={(e) => setPhoneNumber(e.target.value.replace(/[^\d]/g, ""))}
                  placeholder="812345678"
                />
              </div>
            </div>

            {/*
              The number as Center will receive it. A wrong one here is otherwise invisible:
              Center answers with a reference either way, so the only symptom of a bad number is
              a code that never arrives, on a screen that says it was sent.
            */}
            {sending && (
              <p className="text-xs text-muted-foreground">
                We&apos;ll text the code to <span className="font-medium text-foreground">+{phoneCountry}{sending}</span>
                {sending !== phoneNumber.trim() && " — the leading 0 isn't used with a country code"}.
              </p>
            )}

            {error && (
              <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            )}

            <DialogFooter>
              <Button type="submit" disabled={busy}>
                {busy ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Sending…
                  </>
                ) : (
                  "Send code"
                )}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <form onSubmit={onVerify} className="space-y-4" noValidate>
            <div className="space-y-1.5">
              <Label htmlFor="sms-code">Verification code</Label>
              <Input
                id="sms-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                required
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="123456"
              />
            </div>

            {error && (
              <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            )}

            <DialogFooter className="gap-2 sm:gap-2">
              <Button type="button" variant="ghost" onClick={() => setStep("phone")} disabled={busy}>
                Back
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Verifying…
                  </>
                ) : (
                  "Turn on"
                )}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
