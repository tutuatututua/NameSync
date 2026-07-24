import { randomInt } from "node:crypto";
import type { TwoFactorChallenge } from "@extensions/contract";
import { env } from "../config/env";
import { Unauthorized } from "../lib/errors";
import { hashPassword, verifyPassword } from "../lib/password";
import { sendLoginCode, type LogFn } from "../lib/mailer";
import { EmailOtpModel } from "../models";
import { issueSession, verifyCredentials, type LoginResult } from "./auth.service";

/**
 * Email one-time-code sign-in, end to end.
 *
 * Two factors, one endpoint, two steps — the same stateless shape as the Center path:
 *
 *   1. email+password  → verify the password, email a fresh code, answer with a challenge
 *                        (`ref` is the code's id). No session yet, no cookie.
 *   2. email+password+code+ref → verify the password again, check the code, mint a session.
 *
 * The password is proven on BOTH steps because nothing is held between them; the code is the
 * second factor layered on top. Every failure that could reveal whether an email exists —
 * unknown account, wrong password — is funnelled through verifyCredentials, which answers
 * identically either way. See services/auth.service.ts and lib/mailer.ts.
 */

export type OtpSignInResult =
  | { kind: "session"; session: LoginResult }
  | { kind: "twoFactor"; challenge: TwoFactorChallenge };

export interface OtpSignInInput {
  email: string;
  password: string;
  /** Present on step two, once the user has entered the emailed code. */
  code?: string;
  /** The challenge reference (the code's id) echoed back from step one. */
  ref?: string;
  meta?: { userAgent?: string; ip?: string };
  /** Where the mailer writes to when SMTP is unconfigured (dev). The route passes req.log. */
  log?: LogFn;
}

/** A fresh 6-digit code, uniformly random over 000000–999999. */
const generateCode = (): string => randomInt(0, 1_000_000).toString().padStart(6, "0");

const otpExpiry = (): Date => new Date(Date.now() + env.OTP_TTL_MINUTES * 60 * 1000);

/**
 * Step one: password checks out, so mint a code, store only its hash, and email the plaintext.
 * Any code the user was already holding is burned first, so only the newest one can be spent.
 */
async function requestCode(input: OtpSignInInput): Promise<OtpSignInResult> {
  const user = await verifyCredentials(input.email, input.password, input.meta);

  await EmailOtpModel.invalidatePending(user.id);

  const code = generateCode();
  const ref = await EmailOtpModel.create({
    userId: user.id,
    codeHash: await hashPassword(code),
    expiresAt: otpExpiry(),
    ip: input.meta?.ip,
    userAgent: input.meta?.userAgent,
  });

  // Send to the account's own address, not whatever was typed in — they are the same after a
  // successful password check (email is the lookup key), and this way the code can only ever
  // reach the real owner's inbox.
  await sendLoginCode(user.email, code, input.log);

  return { kind: "twoFactor", challenge: { twoFactorRequired: true, method: "email", ref } };
}

/**
 * Step two: password checks out again, and the code must still be live and correct. A wrong
 * code is counted and, past the cap, burns the code; a right code is spent atomically so it
 * can never be replayed.
 */
async function verifyCode(input: OtpSignInInput, code: string, ref: string): Promise<OtpSignInResult> {
  const user = await verifyCredentials(input.email, input.password, input.meta);

  // One message for every "this code won't do" case — expired, spent, wrong account, burned —
  // so a probe can't tell them apart.
  const reject = (): never => {
    throw new Unauthorized("That code is incorrect or has expired. Request a new one.");
  };

  const otp = await EmailOtpModel.findById(ref);
  if (
    !otp ||
    otp.user_id !== user.id ||
    otp.purpose !== "login" ||
    otp.consumed_at !== null ||
    new Date(otp.expires_at).getTime() <= Date.now() ||
    otp.attempts >= env.OTP_MAX_ATTEMPTS
  ) {
    reject();
  }

  const codeOk = await verifyPassword(code.trim(), otp!.code_hash);
  if (!codeOk) {
    // Count the miss; once it reaches the cap the code is dead for everyone, guesser included.
    await EmailOtpModel.incrementAttempts(ref);
    reject();
  }

  // Winner-takes-all: only the request that flips the row from unspent proceeds. This closes
  // the window where the same valid code is submitted twice at once.
  if (!(await EmailOtpModel.consume(ref))) reject();

  return { kind: "session", session: await issueSession(user, input.meta) };
}

export async function signInWithOtp(input: OtpSignInInput): Promise<OtpSignInResult> {
  const code = input.code?.trim();
  // Both must be present to be a verify; a bare email+password (or a half-filled second step)
  // is treated as "send me a code".
  if (code && input.ref) return verifyCode(input, code, input.ref);
  return requestCode(input);
}
