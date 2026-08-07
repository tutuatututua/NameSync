import type { TwoFactorChallenge } from "@extensions/contract";
import { Forbidden, Unauthorized } from "../lib/errors";
import { centerLogin, centerMe, centerSendEmailOtp, centerSendSmsOtp, type CenterCredentials } from "../lib/center";
import { UserModel } from "../models";
import {
  checkLoginThrottle,
  clearLoginThrottle,
  issueSession,
  recordLoginFailure,
} from "./auth.service";
import type { LoginResult } from "./auth.service";

/**
 * Center sign-in, end to end.
 *
 * The shape of it: Center *authenticates* (owns the password and the second factor), and
 * Network Intel *authorises* (owns who is allowed in, and with what roles). So a login only
 * succeeds when BOTH agree — Center accepts the credentials, and an `app_user` row already
 * exists for that email. Center accepting a whole company's credentials does not put anyone
 * into Network Intel who an admin hasn't first added. See docs/AUTH.md.
 *
 * There is no auto-provisioning, on purpose: a Center account with no `app_user` is turned
 * away, not silently created.
 */

export type CenterSignInResult =
  | { kind: "session"; session: LoginResult }
  | { kind: "twoFactor"; challenge: TwoFactorChallenge };

export interface CenterSignInInput {
  email: string;
  password: string;
  /** Present on the second step, once the user has entered their second factor. */
  code?: string;
  method?: "totp" | "email" | "sms";
  /** The OTP reference echoed back from an email/sms challenge. */
  ref?: string;
  meta?: { userAgent?: string; ip?: string };
}

/** Turn the request into the credentials Center wants, routing `code` to the right field. */
function toCredentials(input: CenterSignInInput): CenterCredentials {
  const base: CenterCredentials = { username: input.email, password: input.password };
  if (!input.code) return base;
  // A code delivered out-of-band — emailed or texted — is an OTP and needs its ref; a code
  // from an authenticator app is a TOTP and stands alone.
  if (input.method === "email" || input.method === "sms") return { ...base, otp: input.code, otpRef: input.ref };
  return { ...base, totp: input.code };
}

export async function signInWithCenter(input: CenterSignInInput): Promise<CenterSignInResult> {
  const ip = input.meta?.ip;

  // Rate-limit BEFORE calling Center, not after. Center enforces its own lockout — about five
  // tries, then fifteen minutes — so an unthrottled proxy lets anyone burn a real user's Center
  // attempts and lock them out of Center entirely, not just out of this app. Refusing here
  // first is what stops this endpoint being a remote lockout button.
  checkLoginThrottle(input.email, ip);

  let result;
  try {
    result = await centerLogin(toCredentials(input));
  } catch (err) {
    // Count only what Center calls a credentials failure — a wrong password, or a wrong
    // second-factor code. Center being unreachable (503) is not the caller's fault and must
    // not consume their allowance.
    if (err instanceof Unauthorized) recordLoginFailure(input.email, ip);
    throw err;
  }

  // Center wants a second factor. Relay the challenge; for an out-of-band code (email or sms),
  // also trigger the send so it's in the user's inbox / on their phone by the time they're
  // asked for it. (A TOTP needs no send — the authenticator app already has it.)
  if (result.kind === "twoFactor") {
    if (result.method === "email") await centerSendEmailOtp(input.email);
    else if (result.method === "sms") await centerSendSmsOtp(input.email);
    return {
      kind: "twoFactor",
      challenge: { twoFactorRequired: true, method: result.method, ref: result.ref },
    };
  }

  // Center authenticated the user, but a Center password past its expiry can't be renewed
  // from here — send them to Center to reset rather than minting a session on stale creds.
  if (result.requiredReset) {
    throw new Forbidden("Your Center password has expired. Please reset it in Center, then sign in again.");
  }

  // Who Center says this is. The email is the key we authorise against.
  const profile = await centerMe(result.token);
  const email = profile.email ?? input.email;

  const user = await UserModel.findByEmail(email);
  // Authenticated by Center, but not authorised for Network Intel: no row, or a disabled one.
  if (!user) {
    throw new Forbidden("Your Center account isn't authorised for Network Intel. Ask an administrator to add you.");
  }
  if (!user.is_active) {
    throw new Forbidden("This account has been disabled. Contact an administrator.");
  }

  // Center accepted them AND they are authorised here — the slate is clean.
  clearLoginThrottle(input.email, ip);
  return { kind: "session", session: await issueSession(user, input.meta) };
}
