import { appendFile } from "node:fs/promises";
import nodemailer, { type Transporter } from "nodemailer";
import { env, isProduction, isSmtpConfigured } from "../config/env";
import { ServiceUnavailable } from "./errors";

/**
 * Outbound email, over SMTP (nodemailer).
 *
 * There is exactly one thing Network Intel emails today — a sign-in code — so that is the whole
 * surface here. The transport is built once, lazily, from the SMTP_* env (config/env.ts).
 *
 * When SMTP is not configured the mailer does NOT fail silently: in development it logs the
 * code to the server log so the flow is fully usable with no mail server, and in production
 * it refuses (a code no one receives is not a login, and env.ts already fails at boot if the
 * OTP path is the only way in without SMTP). The code is only ever logged in dev.
 */

let transporter: Transporter | null = null;

function getTransport(): Transporter {
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    // Implicit TLS is the norm only on 465; 587 speaks STARTTLS, which nodemailer negotiates
    // on its own. Default to "secure iff 465" when SMTP_SECURE is left unset.
    secure: env.SMTP_SECURE ?? env.SMTP_PORT === 465,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
  });
  return transporter;
}

/** The From: address on our mail. SMTP_FROM wins; SMTP_USER is the sensible fallback. */
const fromAddress = (): string => env.SMTP_FROM || env.SMTP_USER || "no-reply@namesync.local";

/** A minimal log sink — a Fastify logger or `console` both satisfy it. */
export type LogFn = (msg: string) => void;

/**
 * Where an unsent sign-in code goes when there is no mail server — in ADDITION to the log.
 *
 * The log alone turned out not to be good enough. Container logs die with the container, so
 * anyone who rebuilds or recreates the API while someone is halfway through signing in
 * destroys the one copy of the code they were waiting for. The person sees only "that code
 * is incorrect", with nothing to suggest the code never reached them.
 *
 * So when OTP_DEV_SINK names a path, the code is appended there too. Point it at something
 * that outlives the container (the api-data volume is mounted at /data) and the code is still
 * readable afterwards.
 *
 * Opt-in, and impossible in production: this writes a live credential to disk in plaintext,
 * which is acceptable only because it is the same secret already being printed to the log,
 * on a stack that has deliberately not configured email. `isProduction` returns above before
 * this is ever reached, and env.ts refuses to boot production with the OTP path as the only
 * way in and no SMTP.
 */
async function writeDevSink(to: string, code: string, log?: LogFn): Promise<void> {
  const target = env.OTP_DEV_SINK?.trim();
  if (!target) return;
  try {
    await appendFile(target, `${new Date().toISOString()}  ${to}  ${code}\n`, "utf8");
  } catch (err) {
    // Never fail a sign-in because a debugging convenience could not be written. The code has
    // already gone to the log by this point, so the flow still works.
    const reason = err instanceof Error ? err.message : String(err);
    (log ?? ((m: string) => console.warn(m)))(`[mailer] could not write OTP_DEV_SINK (${target}): ${reason}`);
  }
}

/**
 * Email a one-time sign-in code. Throws (502/503) if a configured SMTP server rejects the
 * send, so the caller can tell the user delivery failed rather than leaving them waiting for
 * a code that never comes.
 */
export async function sendLoginCode(to: string, code: string, log?: LogFn): Promise<void> {
  const ttl = env.OTP_TTL_MINUTES;
  const subject = "Your Network Intel sign-in code";
  const text =
    `Your Network Intel sign-in code is ${code}.\n\n` +
    `It expires in ${ttl} minute${ttl === 1 ? "" : "s"}. ` +
    `If you didn't try to sign in, you can ignore this email.`;
  const html =
    `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:420px">` +
    `<p style="font-size:14px;color:#334155">Your Network Intel sign-in code is</p>` +
    `<p style="font-size:30px;font-weight:700;letter-spacing:6px;margin:12px 0;color:#0f172a">${code}</p>` +
    `<p style="font-size:13px;color:#64748b">It expires in ${ttl} minute${ttl === 1 ? "" : "s"}. ` +
    `If you didn't try to sign in, you can ignore this email.</p></div>`;

  if (!isSmtpConfigured()) {
    if (isProduction) {
      throw new ServiceUnavailable("Email delivery is not configured, so a sign-in code cannot be sent.");
    }
    // Dev/test convenience: no mail server, so hand the code to whoever is watching the log.
    (log ?? ((m: string) => console.warn(m)))(`[mailer] SMTP not configured — sign-in code for ${to}: ${code}`);
    await writeDevSink(to, code, log);
    return;
  }

  await getTransport().sendMail({ from: fromAddress(), to, subject, text, html });
}
