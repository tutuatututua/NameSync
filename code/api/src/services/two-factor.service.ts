import type { TwoFactorChallenge } from "@extensions/contract";
import {
  centerGenerateTotp,
  centerSendSmsEnrollCode,
  centerStatusTotp,
  centerUpdateTotp,
  centerVerifySmsEnrollCode,
  centerVerifyTotp,
  type CenterTotpFlag,
} from "../lib/center";
import { Unauthorized } from "../lib/errors";
import {
  closeReauthWindow,
  getReauthWindow,
  openReauthWindow,
  setPendingSecret,
  setPendingSms,
  type ReauthWindow,
} from "../lib/reauth-window";
import { reauthenticateWithCenter } from "./center-auth.service";

/**
 * Managing the signed-in user's Center two-factor settings, from Network Intel.
 *
 * Network Intel owns none of this — Center does. Every method here is a thin, authorised proxy
 * over Center's own TOTP endpoints (lib/center.ts), gated behind a re-authentication window
 * (lib/reauth-window.ts): the user confirms their Center password once, and that unlocks these
 * calls for a few minutes. Turn 2FA on or off here and it changes the account's real Center
 * 2FA — the same factor Network Intel's login will then demand.
 *
 * v1 covers the authenticator (TOTP). SMS uses the same window and Center's sendcode/verifycode;
 * it is a later addition on this exact plumbing.
 */

/** Center's tri-state flag, translated for the client: which second factor is active. */
export type TwoFactorMethodState = "none" | "totp" | "sms";

const toState = (flag: CenterTotpFlag): TwoFactorMethodState =>
  flag === "Y" ? "totp" : flag === "M" ? "sms" : "none";

export interface BeginReauthInput {
  /** The signed-in user's email — from the session, never the client. */
  email: string;
  password: string;
  /** Second-factor code + its reference, on the second step when the account already has 2FA. */
  code?: string;
  method?: "totp" | "email" | "sms";
  ref?: string;
  /** Identifies THIS session's window — the caller passes their session-token hash. */
  windowKey: string;
  meta?: { userAgent?: string; ip?: string };
}

export type BeginReauthResult =
  | { kind: "twoFactor"; challenge: TwoFactorChallenge }
  | { kind: "ready"; method: TwoFactorMethodState };

/**
 * Step one of managing 2FA: re-confirm the password (and current factor, if any). On success
 * the Center token is parked in the window and the account's current 2FA method is returned,
 * so the settings page can render the real state straight away.
 */
export async function beginReauth(input: BeginReauthInput): Promise<BeginReauthResult> {
  const result = await reauthenticateWithCenter({
    email: input.email,
    password: input.password,
    code: input.code,
    method: input.method,
    ref: input.ref,
    meta: input.meta,
  });

  if (result.kind === "twoFactor") return { kind: "twoFactor", challenge: result.challenge };

  const username = result.profile.username ?? input.email;
  const account = { username, id: result.profile.id ?? username };
  openReauthWindow(input.windowKey, result.token, account);

  const flag = await centerStatusTotp(result.token, username);
  return { kind: "ready", method: toState(flag) };
}

/** The live window, or a 401 telling the caller to re-confirm the password. */
function requireWindow(windowKey: string): ReauthWindow {
  const w = getReauthWindow(windowKey);
  if (!w) throw new Unauthorized("Please confirm your password again to manage two-factor authentication.");
  return w;
}

/** The account's current 2FA method (re-read from Center), for refreshing the settings page. */
export async function getStatus(windowKey: string): Promise<TwoFactorMethodState> {
  const w = requireWindow(windowKey);
  return toState(await centerStatusTotp(w.centerToken, w.account.username));
}

/**
 * Start authenticator enrolment: get a fresh secret + its QR URL from Center, and remember the
 * secret in the window so `enableTotp` can verify against it. Nothing is enabled yet.
 */
export async function setupTotp(windowKey: string): Promise<{ secret: string; otpauthUrl: string }> {
  const w = requireWindow(windowKey);
  const generated = await centerGenerateTotp(w.centerToken, w.account.username);
  setPendingSecret(windowKey, generated.secret);
  return generated;
}

/**
 * Finish enrolment: verify a code from the just-set-up authenticator. Center activates TOTP on
 * success (its verify-totp both checks and enables), so a `true` here means 2FA is now on.
 */
export async function enableTotp(windowKey: string, code: string): Promise<{ enabled: boolean; method: TwoFactorMethodState }> {
  const w = requireWindow(windowKey);
  if (!w.pendingSecret) {
    // enable without a preceding setup — the secret is gone (window replaced, or steps skipped).
    throw new Unauthorized("Start setup again — the previous authenticator secret is no longer available.");
  }
  const ok = await centerVerifyTotp(w.centerToken, {
    username: w.account.username,
    secret: w.pendingSecret,
    code: code.trim(),
  });
  if (!ok) return { enabled: false, method: "none" };
  return { enabled: true, method: "totp" };
}

/** Turn 2FA off (Center flag → "N"), whichever method is currently active. */
export async function disableTotp(windowKey: string): Promise<{ method: TwoFactorMethodState }> {
  const w = requireWindow(windowKey);
  await centerUpdateTotp(w.centerToken, w.account.username, "N");
  return { method: "none" };
}

// ── SMS enrolment ──────────────────────────────────────────────────────────────

/**
 * Start SMS enrolment: ask Center to text a code to the given number, and remember the number
 * + reference in the window so `enableSms` can verify against them. Nothing is enabled yet.
 */
export async function sendSmsCode(
  windowKey: string,
  phone: { phoneCountry: string; phoneNumber: string }
): Promise<void> {
  const w = requireWindow(windowKey);
  const ref = await centerSendSmsEnrollCode(w.centerToken, w.account, phone);
  setPendingSms(windowKey, { ref, phoneCountry: phone.phoneCountry, phoneNumber: phone.phoneNumber });
}

/**
 * Finish SMS enrolment: verify the texted code, then — unlike TOTP — flip the flag to "M"
 * ourselves, because Center's verifycode only confirms the number; it does not activate.
 */
export async function enableSms(
  windowKey: string,
  code: string
): Promise<{ enabled: boolean; method: TwoFactorMethodState }> {
  const w = requireWindow(windowKey);
  if (!w.pendingSms) {
    throw new Unauthorized("Start SMS setup again — the previous request is no longer available.");
  }
  const ok = await centerVerifySmsEnrollCode(w.centerToken, w.account, {
    ref: w.pendingSms.ref,
    code: code.trim(),
    phoneNumber: w.pendingSms.phoneNumber,
  });
  if (!ok) return { enabled: false, method: "none" };
  await centerUpdateTotp(w.centerToken, w.account.username, "M");
  return { enabled: true, method: "sms" };
}

/** Close the window — done managing, or cancelled. */
export function endReauth(windowKey: string): void {
  closeReauthWindow(windowKey);
}
