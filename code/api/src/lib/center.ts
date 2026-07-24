import { env } from "../config/env";
import { BadRequest, ServiceUnavailable, Unauthorized } from "./errors";

/**
 * The Center (centerapp.io "PlayMe") auth API, as NameSync talks to it.
 *
 * NameSync's own login form posts email+password here; this module forwards them to Center,
 * and the caller (services/center-auth.service.ts) takes the Center JWT it returns, reads the
 * profile once, and then throws the token away — NameSync mints its OWN session cookie. See
 * docs/AUTH.md and docs/wayfinder/assets/06-center-sso-integration-spec.md.
 *
 * Center speaks a few non-obvious dialects, and hiding them is the whole job of this module:
 *  - A 2FA-protected account answers a plain password with an *error* (`Require TOTP`), not a
 *    token; the error_description names the second factor.
 *  - Bad credentials and lockouts arrive as free-text error strings with `life:`/`lock_time:`
 *    baked in. We do not parrot those back — every wrong-credentials case gets one flat
 *    message, so the endpoint can't be used to tell "no such user" from "wrong password".
 *  - Center being unreachable is a 503 here, deliberately: in production Center is the only
 *    way in (the local password path is dev-only), so there is nothing to fall back to and
 *    "temporarily unavailable" is the honest answer — never "wrong password".
 */

const CENTER_TIMEOUT_MS = 10_000;

export interface CenterCredentials {
  /** What the user typed — an email in practice, but Center calls it the username. */
  username: string;
  password: string;
  /** TOTP authenticator code, on the second call for an authenticator-app account. */
  totp?: string;
  /** Emailed OTP code + the reference from the challenge, on the second call for email 2FA. */
  otp?: string;
  otpRef?: string;
}

export type CenterLoginResult =
  | { kind: "success"; token: string; requiredReset: boolean }
  | { kind: "twoFactor"; method: "totp" | "email"; ref: string | null };

/** The base URL, trailing slash guaranteed. Throws 503 if Center isn't configured at all. */
function base(): string {
  const url = env.CENTER_PLAYME_URL;
  if (!url) throw new ServiceUnavailable("Center sign-in is not configured");
  return url.endsWith("/") ? url : url + "/";
}

interface CenterResponse {
  status: number;
  ok: boolean;
  data: Record<string, unknown>;
}

async function centerPost(path: string, body: unknown): Promise<CenterResponse> {
  let res: Response;
  try {
    res = await fetch(base() + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CENTER_TIMEOUT_MS),
    });
  } catch {
    // DNS failure, refused connection, TLS error, timeout — Center is unreachable.
    throw new ServiceUnavailable("Center sign-in is temporarily unavailable. Please try again.");
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, ok: res.ok, data };
}

/** The login request body Center expects, with the optional bits filled in only when present. */
function loginBody(creds: CenterCredentials): Record<string, unknown> {
  const body: Record<string, unknown> = {
    username: creds.username,
    password: creds.password,
    devicePlatform: "web",
  };
  // The second-factor fields are sent ONLY when they carry a real value — never as empty
  // strings. Center reads an empty `otp` together with an empty `otpRef` as "an email code was
  // submitted, and it's blank" and 401s the whole login (verified against the live API: a body
  // with otp:"" + otpRef:"" is rejected, the same body without them succeeds). So a first login
  // carries neither; an authenticator resubmit sets `totp`; an email-code resubmit sets
  // `otp` + `otpRef`.
  if (creds.totp) body.totp = creds.totp;
  if (creds.otp) body.otp = creds.otp;
  if (creds.otpRef) body.otpRef = creds.otpRef;
  // Only when configured — some Center clients require the group id, others reject a login that
  // carries an unexpected one, so an unset value is omitted rather than sent as null.
  if (env.CENTER_GROUP_IAM2_ID) body.groupIam2ID = env.CENTER_GROUP_IAM2_ID;
  return body;
}

/**
 * Sign in at Center. Returns either a token (success) or a 2FA challenge; throws a typed
 * error for everything Center refuses.
 *
 * Call it a second time with `totp` (authenticator) or `otp`+`otpRef` (email) filled in to
 * satisfy a challenge — it is the same endpoint, that is how Center completes 2FA.
 */
export async function centerLogin(creds: CenterCredentials): Promise<CenterLoginResult> {
  const { ok, data } = await centerPost("auth/login", loginBody(creds));

  // Success: Center hands back a JWT. `requiredReset === "Y"` means the password is expired
  // and Center wants it changed — NameSync can't change a Center password, so the caller
  // turns this into a "reset in Center" rejection rather than a session.
  if (ok && typeof data.token === "string" && data.token) {
    return { kind: "success", token: data.token, requiredReset: data.requiredReset === "Y" };
  }

  const error = String(data.error ?? "");
  const description = String(data.error_description ?? "");

  // A 2FA-protected account: Center refuses the plain password and names the second factor
  // in error_description — empty = authenticator app, "email:<ref>" = emailed code, and any
  // other non-empty value is an SMS reference (which we don't support).
  if (error === "Require TOTP" || error === "TOTP required but not provided") {
    if (!description) return { kind: "twoFactor", method: "totp", ref: null };
    if (description.startsWith("email:")) {
      return { kind: "twoFactor", method: "email", ref: description.slice("email:".length) };
    }
    throw new BadRequest(
      "This account uses SMS two-factor sign-in, which isn't supported here. " +
        "Use an authenticator app or an email code, or contact an administrator."
    );
  }

  // A locked account is worth its own message — the user can't fix it by retrying.
  if (/locked/i.test(error)) {
    throw new Unauthorized("This account is locked. Please contact an administrator.");
  }

  // Everything else — wrong password, unknown user, a stray 2FA code — is one flat 401. The
  // attempts-left / lock-time detail in `error` is deliberately not echoed (it would leak
  // whether the account exists); Center still enforces its own lockout regardless.
  throw new Unauthorized("Incorrect email or password");
}

/**
 * Ask Center to email a one-time code, for an account whose second factor is email. Center's
 * challenge doesn't send it; the client must, before the user can enter it.
 */
export async function centerSendEmailOtp(username: string): Promise<void> {
  await centerPost("auth/sendcode", {
    email: username,
    username,
    phoneNumber: "",
    phoneCountry: "",
    isVerifyAccount: false,
    isEmail: true,
    groupIam2ID: env.CENTER_GROUP_IAM2_ID,
  });
}

/**
 * Read the signed-in user's Center profile, using the JWT from a successful login. This is
 * the authoritative identity — NameSync matches its `app_user` against the email here.
 *
 * NOTE: the exact field names in Center's `auth/me` are unconfirmed until ticket 07 (a real
 * specimen). We read the common spellings defensively and fall back to the typed login, so a
 * field-name surprise degrades to "match on what they typed" rather than a crash.
 */
export interface CenterProfile {
  email: string | null;
  name: string | null;
}

export async function centerMe(token: string): Promise<CenterProfile> {
  let res: Response;
  try {
    res = await fetch(base() + "auth/me", {
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(CENTER_TIMEOUT_MS),
    });
  } catch {
    throw new ServiceUnavailable("Center sign-in is temporarily unavailable. Please try again.");
  }
  if (!res.ok) throw new Unauthorized("Center sign-in failed");
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;

  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
  return {
    email: str(data.email) ?? str(data.username) ?? str(data.userName) ?? str(data.mail),
    name: str(data.name) ?? str(data.displayName) ?? str(data.fullName),
  };
}
