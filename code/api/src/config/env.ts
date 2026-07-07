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
  PORT: z.coerce.number().int().positive().default(8080),

  // DB engine. Prefer a Postgres DATABASE_URL; DB_ENGINE can force a specific pool
  // (the sqldb extension's SQLite pools are retained for its own tests).
  DB_ENGINE: z.enum(['postgres', 'sqlite-file', 'sqlite-mem']).optional(),
  DATABASE_URL: z.string().optional(),
  DATABASE_FILE: z.string().optional(),

  // Comma-separated allowed origins. Required in production (no allow-all fallback).
  CORS_ORIGIN: z.string().optional(),

  UPLOAD_DIR: z.string().default('uploads'),

  // External matcher webhooks. Optional here — the app fails loudly per-request if a
  // needed one is missing, rather than refusing to boot.
  COMPANY_WEBHOOK_URL: optionalUrl,
  FACEBOOK_WEBHOOK_URL: optionalUrl,
  COMPARE_WEBHOOK_URL: optionalUrl,
  // Public base URL external services POST results back to. Must be absolute http(s);
  // otherwise the server derives it from the incoming request.
  WEBHOOK_CALLBACK_URL_BASE: z.string().optional(),

  // Shared secret guarding /api/callbacks/* and destructive /all endpoints (auth-lite).
  CALLBACK_TOKEN: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

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
