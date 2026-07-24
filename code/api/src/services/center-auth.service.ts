import type { TwoFactorChallenge } from "@extensions/contract";
import { Forbidden, Unauthorized } from "../lib/errors";
import { centerLogin, centerMe, centerSendEmailOtp, type CenterCredentials } from "../lib/center";
import { UserModel } from "../models";
import { issueSession } from "./auth.service";
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
  method?: "totp" | "email";
  /** The email-OTP reference echoed back from the challenge. */
  ref?: string;
  meta?: { userAgent?: string; ip?: string };
}

/** Turn the request into the credentials Center wants, routing `code` to the right field. */
function toCredentials(input: CenterSignInInput): CenterCredentials {
  const base: CenterCredentials = { username: input.email, password: input.password };
  if (!input.code) return base;
  // A code with method "email" is an emailed OTP (needs its ref); anything else is a TOTP.
  if (input.method === "email") return { ...base, otp: input.code, otpRef: input.ref };
  return { ...base, totp: input.code };
}

export async function signInWithCenter(input: CenterSignInInput): Promise<CenterSignInResult> {
  const result = await centerLogin(toCredentials(input));

  // Center wants a second factor. Relay the challenge; for email, also trigger the send so a
  // code is actually in the user's inbox by the time they're asked for it.
  if (result.kind === "twoFactor") {
    if (result.method === "email") await centerSendEmailOtp(input.email);
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

  return { kind: "session", session: await issueSession(user, input.meta) };
}
