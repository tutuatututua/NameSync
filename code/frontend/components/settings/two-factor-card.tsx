"use client";

import * as React from "react";
import { QRCodeSVG } from "qrcode.react";
import { Loader2, ShieldCheck, ShieldOff, Smartphone } from "lucide-react";
import type { TwoFactorMethod, TwoFactorMethodState } from "@extensions/contract";
import { api, ApiError } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
 * doesn't keep, the card is gated behind a re-auth: confirm the Center password once and a short
 * window opens for viewing and changing the setting. v1 enrols/removes the authenticator (TOTP);
 * an account already on SMS can be turned off here, but SMS enrolment stays in Center.
 */

/** null = not yet unlocked (password not confirmed this session). */
type MethodState = TwoFactorMethodState | null;

export function TwoFactorCard() {
  const [method, setMethod] = React.useState<MethodState>(null);
  const [reauthOpen, setReauthOpen] = React.useState(false);
  const [setupOpen, setSetupOpen] = React.useState(false);
  const [smsOpen, setSmsOpen] = React.useState(false);
  const [disabling, setDisabling] = React.useState(false);

  const unlocked = method !== null;

  // Closing the re-auth window when the user leaves the page keeps a Center token from lingering
  // in server memory past the moment it is needed. Best-effort — logout also clears it server-side.
  React.useEffect(() => {
    return () => {
      void api.auth.twoFactor.end().catch(() => {});
    };
  }, []);

  /** A 401 from any action means the window lapsed, not that the session died: re-lock and re-prompt. */
  const onActionError = React.useCallback((err: unknown) => {
    if (err instanceof ApiError && err.status === 401) {
      setMethod(null);
      setSetupOpen(false);
      toast.error(err.message || "Please confirm your password again.");
      setReauthOpen(true);
      return;
    }
    toast.error(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
  }, []);

  async function onDisable() {
    setDisabling(true);
    try {
      const res = await api.auth.twoFactor.disable();
      setMethod(res.method);
      toast.success("Two-factor authentication turned off.");
    } catch (err) {
      onActionError(err);
    } finally {
      setDisabling(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Two-factor authentication</CardTitle>
        <CardDescription>
          Require a second step when signing in. Protects your account even if your password is
          known. Managed through your Center account.
        </CardDescription>
      </CardHeader>

      <CardContent>
        {!unlocked ? (
          <p className="text-sm text-muted-foreground">
            Confirm your password to view or change your two-factor settings.
          </p>
        ) : method === "none" ? (
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
        {!unlocked ? (
          <Button onClick={() => setReauthOpen(true)}>Manage</Button>
        ) : method === "none" ? (
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

      <ReauthDialog
        open={reauthOpen}
        onOpenChange={setReauthOpen}
        onReady={(m) => {
          setMethod(m);
          setReauthOpen(false);
        }}
      />

      <TotpSetupDialog
        open={setupOpen}
        onOpenChange={setSetupOpen}
        onEnabled={() => {
          setMethod("totp");
          setSetupOpen(false);
          toast.success("Authenticator app enabled.");
        }}
        onActionError={onActionError}
      />

      <SmsSetupDialog
        open={smsOpen}
        onOpenChange={setSmsOpen}
        onEnabled={() => {
          setMethod("sms");
          setSmsOpen(false);
          toast.success("SMS two-factor authentication enabled.");
        }}
        onActionError={onActionError}
      />
    </Card>
  );
}

/**
 * Confirm the Center password to open the management window. If the account already has 2FA on,
 * Center answers with a challenge and we ask for the current code before the window opens.
 */
function ReauthDialog({
  open,
  onOpenChange,
  onReady,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onReady: (method: TwoFactorMethodState) => void;
}) {
  const [password, setPassword] = React.useState("");
  const [challenge, setChallenge] = React.useState<{ method: TwoFactorMethod; ref: string | null } | null>(null);
  const [code, setCode] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  // Reset every field whenever the dialog is (re)opened, so a previous attempt never leaks in.
  React.useEffect(() => {
    if (open) {
      setPassword("");
      setChallenge(null);
      setCode("");
      setError(null);
      setSubmitting(false);
    }
  }, [open]);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result = await api.auth.twoFactor.reauth({
        password,
        code: challenge ? code : undefined,
        method: challenge?.method,
        ref: challenge?.ref ?? undefined,
      });
      if ("twoFactorRequired" in result) {
        // Account already protected — collect the current second factor, then re-submit.
        setChallenge({ method: result.method, ref: result.ref });
        setCode("");
        setSubmitting(false);
        return;
      }
      onReady(result.method);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't confirm your password. Please try again.");
      setCode("");
      setSubmitting(false);
    }
  }

  const hint = challenge
    ? challenge.method === "totp"
      ? "Enter the current code from your authenticator app."
      : challenge.method === "sms"
        ? "Enter the code we texted you."
        : "Enter the code we emailed you."
    : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Confirm your password</DialogTitle>
          <DialogDescription>
            {hint ?? "For your security, confirm your Center password to manage two-factor authentication."}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          {!challenge ? (
            <div className="space-y-1.5">
              <Label htmlFor="reauth-password">Password</Label>
              <Input
                id="reauth-password"
                type="password"
                autoComplete="current-password"
                autoFocus
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="reauth-code">Verification code</Label>
              <Input
                id="reauth-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                required
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="123456"
              />
            </div>
          )}

          {error && (
            <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button type="submit" disabled={submitting}>
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Confirming…
                </>
              ) : (
                "Confirm"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
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

  async function onSendCode(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.auth.twoFactor.sendSmsCode({ phoneCountry: phoneCountry.trim(), phoneNumber: phoneNumber.trim() });
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
              : `Enter the code we texted to +${phoneCountry} ${phoneNumber}.`}
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
