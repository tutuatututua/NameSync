import { z } from 'zod';

/**
 * Single, fail-fast source of truth for API configuration. Parsed once at import;
 * an invalid/missing-in-production value logs a clear message and exits instead of
 * failing deep inside a request. Dev has sane localhost defaults so `npm run dev`
 * works with no .env; production requires the real values.
 */

const optionalUrl = z.string().url().or(z.literal('')).optional();

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),

  // DB engine. Prefer a Postgres DATABASE_URL; DB_ENGINE can force a specific pool
  // (the sqldb extension's SQLite pools are retained for its own tests).
  DB_ENGINE: z.enum(['postgres', 'sqlite-file', 'sqlite-mem']).optional(),
  DATABASE_URL: z.string().optional(),
  DATABASE_FILE: z.string().optional(),

  // Comma-separated allowed origins. Required in production (no allow-all fallback).
  CORS_ORIGIN: z.string().optional(),

  UPLOAD_DIR: z.string().default('uploads'),

  // External *ingestion* webhooks, still used by /:id/send-webhook. Optional here — the
  // app fails loudly per-request if a needed one is missing, rather than refusing to boot.
  COMPANY_WEBHOOK_URL: optionalUrl,
  FACEBOOK_WEBHOOK_URL: optionalUrl,

  // ── Which matcher runs ────────────────────────────────────────────────────
  // Off (the default): NameSync scores names itself, in Postgres (matcher.service), and a
  // compare run finishes inside the request that started it. An import is just an import.
  //
  // On: the external workflow is the matcher. An import also *starts a run* — its rows land
  // at status='processing', a `comparison` is opened for them, and the workflow stamps each
  // row 'match'/'unmatch' and writes the pairs into comparison_result directly in Postgres.
  // NameSync finds out by polling its own tables; there is no callback. See docs/EXTERNAL-MATCHER.md.
  //
  // A flag rather than a replacement because the two matchers disagree about *when* an
  // answer exists — one returns it, the other is waited on — and that difference reaches all
  // the way into the UI. Both paths stay live so this can be turned off again without a deploy.
  EXTERNAL_MATCHER: z.string().optional(),
  // Public base URL external services POST results back to. Must be absolute http(s);
  // otherwise the server derives it from the incoming request.
  WEBHOOK_CALLBACK_URL_BASE: z.string().optional(),

  // Shared secret guarding /api/callbacks/* and destructive /all endpoints (auth-lite).
  CALLBACK_TOKEN: z.string().optional(),

  // ── Auth ──────────────────────────────────────────────────────────────────
  // NameSync signs people in itself: a password against `app_user`, then an opaque
  // session token in an httpOnly cookie (lib/session.ts). There is nothing to configure
  // for it to work — no secret, no issuer, no JWKS — because there is no external issuer
  // to agree with any more. What is left is cookie policy and how long a session lasts.
  //
  // How long a session survives without activity. It slides on use, so this is an
  // idle timeout, not a hard cap. 168h = 7 days.
  SESSION_TTL_HOURS: z.coerce.number().positive().max(8760).default(168),
  AUTH_COOKIE_NAME: z.string().default('namesync_session'),
  // `lax` is right whenever the site and the API share a registrable domain — including
  // localhost:3000 -> localhost:4000, because the port is not part of the "site". Only a
  // genuinely cross-site deployment needs `none`, and the browser then requires Secure.
  AUTH_COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),
  // Defaults to true in production and false elsewhere (a Secure cookie is dropped over
  // plain http, which would make local dev impossible to sign in to).
  AUTH_COOKIE_SECURE: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  // Set only to share the cookie across subdomains (e.g. `.example.com`).
  AUTH_COOKIE_DOMAIN: z.string().optional(),
  // Dev/test escape hatch: skip auth entirely and treat every request as a local admin.
  // Refused in production.
  AUTH_DISABLED: z.string().optional(),

  // ── Center sign-in (centerapp.io) ──────────────────────────────────────────
  // The production identity source. NameSync forwards email+password to Center's auth API,
  // and on success mints its own session (lib/center.ts, services/center-auth.service.ts).
  // Required in production — with it unset there is no way to sign in to a prod deploy, since
  // the local password path is dev-only (see the login route). See docs/AUTH.md.
  //
  // The base URL of Center's "PlayMe" auth API, e.g. https://centerapp.io/center/ — a trailing
  // slash is added if missing. `auth/login`, `auth/me`, `auth/sendcode` hang off it.
  CENTER_PLAYME_URL: optionalUrl,
  // The IAM2 group id Center expects on a login/sendcode call (the closest thing to a client
  // id in Center's model). Optional — sent when set. Comes from ticket 07 (client registration).
  CENTER_GROUP_IAM2_ID: z.string().optional(),

  // ── Email-OTP sign-in + outbound email (SMTP) ───────────────────────────────
  // A second, NameSync-owned login path: password, then a one-time code emailed from here.
  // See services/otp-auth.service.ts and lib/mailer.ts. The code is delivered over SMTP.
  //
  // With SMTP_HOST set, mail is actually sent. Unset in dev/test, the mailer instead LOGS
  // the code to the server log so the flow is usable with no mail server — but a production
  // deploy that means to use this path must configure real SMTP (checked at boot below).
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().max(65535).default(587),
  // Implicit TLS on connect (true => port 465). Most providers use false + STARTTLS on 587.
  SMTP_SECURE: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  // The From: address on OTP mail, e.g. "NameSync <no-reply@example.com>". Falls back to
  // SMTP_USER when unset. Required (as itself or SMTP_USER) once SMTP_HOST is set.
  SMTP_FROM: z.string().optional(),

  // How long an emailed code is good for, and how many wrong guesses it survives before it
  // is burned. Short + few is the whole security of a 6-digit code.
  OTP_TTL_MINUTES: z.coerce.number().int().positive().max(60).default(10),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().max(20).default(5),

  // Optional read-only connection for the SQL console. Falls back to DATABASE_URL,
  // which is still safe (read-only transaction), but a role that physically cannot
  // write is the stronger guarantee.
  DATABASE_URL_READONLY: z.string().optional(),
  // Server-side cap on a SQL console query.
  SQL_CONSOLE_TIMEOUT_MS: z.coerce.number().int().positive().max(60_000).default(5_000),
  SQL_CONSOLE_MAX_ROWS: z.coerce.number().int().positive().max(10_000).default(1_000),
});

export type Env = z.infer<typeof EnvSchema>;

/** A flag, not a value: any non-empty, non-"false"/"0" string turns it on. */
const isFlagOn = (raw: string | undefined): boolean => {
  const v = raw?.trim().toLowerCase();
  return !!v && v !== 'false' && v !== '0';
};

/** AUTH_DISABLED is a flag, not a value: any non-empty, non-"false"/"0" string turns it on. */
export const isAuthDisabled = (e: Pick<Env, 'AUTH_DISABLED'>): boolean => isFlagOn(e.AUTH_DISABLED);

function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    // eslint-disable-next-line no-console
    console.error(
      'Invalid environment configuration:\n' +
        parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n')
    );
    process.exit(1);
  }

  const env = parsed.data;
  const isProd = env.NODE_ENV === 'production';

  const missing: string[] = [];
  if (isProd && !env.CORS_ORIGIN) missing.push('CORS_ORIGIN (required in production — no allow-all)');
  if (isProd && !env.DATABASE_URL && env.DB_ENGINE !== 'sqlite-file' && env.DB_ENGINE !== 'sqlite-mem') {
    missing.push('DATABASE_URL (required in production Postgres)');
  }
  // Auth must be real in production: no silent open door, and no opt-out. There is
  // nothing else to require — the app is its own issuer now, so there is no shared secret
  // to forget to set, which is one whole class of misconfiguration deleted.
  if (isProd && isAuthDisabled(env)) {
    missing.push('AUTH_DISABLED must not be set in production (it turns auth off entirely)');
  }
  // A production deploy needs at least one real way in. The local password path is dev-only,
  // so that leaves two: Center (CENTER_PLAYME_URL) and email-OTP (SMTP_HOST). Require at least
  // one — a deploy with neither is locked out. Fail at boot, not at first login.
  if (isProd && !env.CENTER_PLAYME_URL && !env.SMTP_HOST) {
    missing.push(
      'a production sign-in path: set CENTER_PLAYME_URL (Center) and/or SMTP_HOST (email-OTP) — with neither, no one can sign in'
    );
  }
  // If email-OTP is configured, it must be able to actually send: an SMTP_HOST with no From
  // address would accept the login and then fail to deliver the code. Fail at boot instead.
  if (isProd && env.SMTP_HOST && !env.SMTP_FROM && !env.SMTP_USER) {
    missing.push('SMTP_FROM (or SMTP_USER) is required when SMTP_HOST is set — it is the From: address on OTP mail');
  }
  // A SameSite=None cookie without Secure is silently DROPPED by every current browser —
  // so this misconfiguration would present as "login succeeds, then nothing is signed in".
  // Fail at boot with the reason instead of at 2am with the symptom.
  // Checked against the *effective* value, since AUTH_COOKIE_SECURE defaults to `isProd`
  // when unset — so SameSite=none in dev is broken even though nobody set it to false.
  const cookieSecure = env.AUTH_COOKIE_SECURE ?? isProd;
  if (env.AUTH_COOKIE_SAMESITE === 'none' && !cookieSecure) {
    missing.push('AUTH_COOKIE_SECURE=true is required when AUTH_COOKIE_SAMESITE=none (browsers drop the cookie otherwise)');
  }
  if (isProd && env.AUTH_COOKIE_SECURE === false) {
    missing.push('AUTH_COOKIE_SECURE=false is refused in production (it would send the session cookie over plain http)');
  }
  if (missing.length > 0) {
    // eslint-disable-next-line no-console
    console.error('Missing required environment for production:\n' + missing.map((m) => `  - ${m}`).join('\n'));
    process.exit(1);
  }

  return env;
}

export const env = loadEnv();

/** Parsed, trimmed CORS origins (empty array => reflect none / disallow when set). */
export const corsOrigins: string[] = (env.CORS_ORIGIN ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

/** Is Center sign-in wired up? */
export const isCenterConfigured = (): boolean => !!env.CENTER_PLAYME_URL;

/**
 * Is email actually deliverable? True once SMTP_HOST is set. When false the mailer logs the
 * code instead of sending it (dev convenience) — production requires this to be true if the
 * OTP path is meant to be usable, since a code no one receives is not a login.
 */
export const isSmtpConfigured = (): boolean => !!env.SMTP_HOST;

/**
 * Is the external workflow the matcher?
 *
 * Read this rather than `env.EXTERNAL_MATCHER` — it is the difference between an import that
 * finishes when the request returns and one that finishes when a workflow says so.
 */
export const isExternalMatcher = (): boolean => isFlagOn(env.EXTERNAL_MATCHER);
