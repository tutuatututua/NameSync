import { env } from "../config/env";
import { BadRequest, ServiceUnavailable, Unauthorized } from "./errors";

/**
 * The Center (centerapp.io "PlayMe") auth API, as Network Intel talks to it.
 *
 * Network Intel's own login form posts email+password here; this module forwards them to Center,
 * and the caller (services/center-auth.service.ts) takes the Center JWT it returns, reads the
 * profile once, and then throws the token away — Network Intel mints its OWN session cookie. See
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
  | { kind: "twoFactor"; method: "totp" | "email" | "sms"; ref: string | null };

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
  // A 5xx is Center broken, not the user being wrong, and it must be told apart from a
  // rejection. Without this it falls through to centerLogin's catch-all and is reported as
  // "Incorrect email or password" — the exact thing the docblock above promises never happens.
  // Since the sign-in throttle counts credential failures, an outage would also spend a real
  // user's attempts and lock them out over something that was never their fault.
  if (res.status >= 500) {
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
  // and Center wants it changed — Network Intel can't change a Center password, so the caller
  // turns this into a "reset in Center" rejection rather than a session.
  if (ok && typeof data.token === "string" && data.token) {
    return { kind: "success", token: data.token, requiredReset: data.requiredReset === "Y" };
  }

  const error = String(data.error ?? "");
  const description = String(data.error_description ?? "");

  // A 2FA-protected account: Center refuses the plain password and names the second factor
  // in error_description — empty = authenticator app, "email:<ref>" = emailed code, and any
  // other non-empty value is an SMS reference (Center texts the code; we relay it). The SMS
  // ref is the whole description, unless Center prefixes it "sms:" — strip that if present.
  if (error === "Require TOTP" || error === "TOTP required but not provided") {
    if (!description) return { kind: "twoFactor", method: "totp", ref: null };
    if (description.startsWith("email:")) {
      return { kind: "twoFactor", method: "email", ref: description.slice("email:".length) };
    }
    const ref = description.startsWith("sms:") ? description.slice("sms:".length) : description;
    return { kind: "twoFactor", method: "sms", ref };
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
 * Ask Center to text a one-time code, for an account whose second factor is SMS. Like the
 * email path, Center's challenge does not send it — the client must trigger the send. Center
 * texts the account's own registered phone; we do not hold or pass the number (`isEmail:false`
 * with empty phone fields), and the ref from the challenge ties the code to this login.
 */
export async function centerSendSmsOtp(username: string): Promise<void> {
  await centerPost("auth/sendcode", {
    email: username,
    username,
    phoneNumber: "",
    phoneCountry: "",
    isVerifyAccount: false,
    isEmail: false,
    groupIam2ID: env.CENTER_GROUP_IAM2_ID,
  });
}

/**
 * Read the signed-in user's Center profile, using the JWT from a successful login. This is
 * the authoritative identity — Network Intel matches its `app_user` against the email here.
 *
 * The field names below are confirmed against the live auth/me: it returns `email` plus a
 * name split across `firstname`/`lastname`. We still read the other common spellings
 * defensively and fall back to the typed login, so a field-name surprise on another Center
 * tenant degrades to "match on what they typed" rather than a crash.
 */
export interface CenterProfile {
  email: string | null;
  name: string | null;
  /**
   * Center's own account handle. The 2FA (TOTP) APIs key on THIS, not on the email — the
   * setting page passes `myProfile.username` to generate/verify/update-totp — so the 2FA
   * proxy (services/two-factor.service.ts) must use it rather than the login email, which
   * on some tenants is a different string. Falls back to the email when Center omits it.
   */
  username: string | null;
  /**
   * Center's numeric/opaque account id. Center's SMS enrolment sendcode puts THIS in its
   * `username` field (its own settings page sends `props.data.id`); the TOTP calls don't need
   * it. Falls back to the username when Center's profile omits it.
   */
  id: string | null;
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
  // Center's auth/me splits the name across `firstname`/`lastname` (confirmed against the live
  // API) — it has no single `name` field. Join them; keep the one-field spellings first as a
  // fallback in case another Center tenant returns a combined name instead.
  const joined =
    [str(data.firstname) ?? str(data.firstName), str(data.lastname) ?? str(data.lastName)]
      .filter(Boolean)
      .join(" ") || null;
  const email = str(data.email) ?? str(data.username) ?? str(data.userName) ?? str(data.mail);
  const username = str(data.username) ?? str(data.userName) ?? email;
  return {
    email,
    name: str(data.name) ?? str(data.displayName) ?? str(data.fullName) ?? joined,
    username,
    // Center returns the id under a few different keys across tenants; fall back to the
    // username so a missing id degrades to "use the handle" rather than sending null.
    id: str(data.id) ?? str(data.userID) ?? str(data.userId) ?? str(data._id) ?? username,
  };
}

// ── Two-factor (TOTP) management ───────────────────────────────────────────────
// Network Intel does not own 2FA — Center does. These proxy Center's own TOTP endpoints so a
// user can turn an authenticator on/off from Network Intel's settings without visiting Center.
// Every call is authenticated with a Center JWT the caller obtained by re-authenticating the
// user moments earlier (services/two-factor.service.ts); the token is never stored.
//
// The account handle is Center's `username` (CenterProfile.username), and the issuer is always
// "center" — the same values Center's own setting page sends. `flag_totp` is Center's single
// tri-state: "Y" = authenticator, "M" = SMS, "N" = off.

/** Center's tri-state 2FA flag, as it appears on the wire. */
export type CenterTotpFlag = "Y" | "M" | "N";
const ISSUER = "center";

/** A Center call carrying the user's JWT. 5xx and unreachable both become a 503, like the rest. */
async function centerAuthed(
  path: string,
  token: string,
  init: { method: "GET" | "POST"; body?: unknown }
): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(base() + path, {
      method: init.method,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(CENTER_TIMEOUT_MS),
    });
  } catch {
    throw new ServiceUnavailable("Center is temporarily unavailable. Please try again.");
  }
  if (res.status >= 500) {
    throw new ServiceUnavailable("Center is temporarily unavailable. Please try again.");
  }
  // A 401 here means the throwaway token has lapsed — the re-auth window timed out. Tell the
  // caller to send the user back through the password prompt rather than reporting a raw error.
  if (res.status === 401 || res.status === 403) {
    throw new Unauthorized("Your verification has expired. Please confirm your password again.");
  }
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

/** The account's current 2FA method: which factor Center will demand at the next login. */
export async function centerStatusTotp(token: string, username: string): Promise<CenterTotpFlag> {
  const data = await centerAuthed(`auth/status-totp/${encodeURIComponent(username)}`, token, {
    method: "GET",
  });
  const flag = String(data.totp_flag ?? "N").toUpperCase();
  return flag === "Y" || flag === "M" ? (flag as CenterTotpFlag) : "N";
}

/**
 * Begin authenticator enrolment: Center mints a fresh TOTP secret and returns it. Nothing is
 * enabled yet — the secret only becomes the account's second factor once a code from it is
 * verified (centerVerifyTotp). Returns the secret plus the `otpauth://` URL to render as a QR.
 */
export async function centerGenerateTotp(
  token: string,
  username: string
): Promise<{ secret: string; otpauthUrl: string }> {
  const data = await centerAuthed("auth/generate-totp", token, {
    method: "POST",
    body: { username, issuer: ISSUER },
  });
  const secret = String(data.totp_secret ?? "");
  if (!secret) throw new ServiceUnavailable("Center did not return an authenticator secret. Please try again.");
  // Same otpauth string Center's own page builds, so the QR is identical: the label is
  // "issuer:account" and the issuer is repeated as a parameter for apps that read it.
  const label = encodeURIComponent(`${ISSUER}:${username}`).replace(/%20/g, " ");
  const otpauthUrl = `otpauth://totp/${label}?secret=${encodeURIComponent(secret)}&issuer=${encodeURIComponent(ISSUER)}`;
  return { secret, otpauthUrl };
}

/**
 * Verify a code from the just-generated authenticator and, on success, ACTIVATE it — Center's
 * verify-totp does both in one step (its own page does not call update-totp afterwards). Returns
 * true when Center answers `status: "ok"`, false for a wrong/expired code.
 */
export async function centerVerifyTotp(
  token: string,
  input: { username: string; secret: string; code: string }
): Promise<boolean> {
  const data = await centerAuthed("auth/verify-totp", token, {
    method: "POST",
    body: { totp_secret: input.secret, issuer: ISSUER, username: input.username, totp: input.code },
  });
  return String(data.status ?? "").toLowerCase() === "ok";
}

/** Set the account's 2FA flag directly. Used to turn 2FA OFF ("N"); "Y" goes through enrolment. */
export async function centerUpdateTotp(token: string, username: string, flag: CenterTotpFlag): Promise<void> {
  await centerAuthed("auth/update-totp", token, {
    method: "POST",
    body: { username, flag_totp: flag, issuer: ISSUER },
  });
}

// ── SMS enrolment ──────────────────────────────────────────────────────────────
// Registering a phone for SMS 2FA is a three-call dance, and the payloads below mirror
// Center's own settings page field-for-field (its sendcode carries the account HANDLE as
// `email`/`userID` and the account ID as `username`; `isVerifyAccount:true` marks it as an
// enrolment rather than a login send). Center texts the code to the number; the account only
// becomes SMS-protected once the code verifies AND the flag is set to "M" (centerUpdateTotp).
//
// These field names are replicated from the working Center client, not from a published spec —
// worth confirming against your Center once, since the tenant may differ.

/** Identity fields the sendcode/verifycode calls need, from the re-auth window. */
export interface CenterSmsAccount {
  /** CenterProfile.username — Center's `email`/`userID` field. */
  username: string;
  /** CenterProfile.id — Center's `username` field on sendcode. */
  id: string;
}

/**
 * Ask Center to text a verification code to a phone the user wants to register. Returns the
 * reference that ties the eventual code back to this send. Throws a 400 with Center's own
 * message when the number is refused (e.g. already in use on another account).
 */
export async function centerSendSmsEnrollCode(
  token: string,
  account: CenterSmsAccount,
  phone: { phoneCountry: string; phoneNumber: string }
): Promise<string> {
  const data = await centerAuthed("auth/sendcode", token, {
    method: "POST",
    body: {
      email: account.username,
      phoneNumber: phone.phoneNumber,
      phoneCountry: phone.phoneCountry,
      isVerifyAccount: true,
      username: account.id,
      // isEmail marks the delivery channel: Center's account-creation flow (AccountCreate.tsx)
      // sends `false` + a phoneNumber to TEXT the code, and `true` to email it. We want the
      // code texted to the number being registered, so `false`. (Center's own 2FA settings page
      // sends `true` here — a latent quirk, since it also passes a phoneNumber; we follow the
      // account-creation flow's clearer semantics instead. Confirm against your Center.)
      isEmail: false,
      groupIam2ID: env.CENTER_GROUP_IAM2_ID,
    },
  });
  const ref = typeof data.refID === "string" ? data.refID : "";
  if (!ref) {
    // Center reports a refused number as free text in `text` — surface it; it's actionable
    // ("this number is already in use"), not a credentials secret.
    const text = typeof data.text === "string" && data.text ? data.text : "Couldn't send a code to that number.";
    throw new BadRequest(text);
  }
  return ref;
}

/**
 * Verify the texted code against its reference. Returns true when Center answers
 * `status: "ok"|"success"`. Activation (flag → "M") is a separate centerUpdateTotp call.
 */
export async function centerVerifySmsEnrollCode(
  token: string,
  account: CenterSmsAccount,
  input: { ref: string; code: string; phoneNumber: string }
): Promise<boolean> {
  const data = await centerAuthed("auth/verifycode", token, {
    method: "POST",
    body: {
      type: "",
      userID: account.username,
      refID: input.ref,
      code: input.code,
      email: account.username,
      phoneNumber: input.phoneNumber,
      groupIam2ID: env.CENTER_GROUP_IAM2_ID,
    },
  });
  const status = String(data.status ?? "").toLowerCase();
  return status === "ok" || status === "success";
}
