import "dotenv/config";
import { DBModel } from "@extensions/sqldb";
import { UserModel } from "../models";
import { hashPassword } from "../lib/password";

/**
 * Seed a known test account, idempotently.
 *
 *   npm run seed:test-user
 *
 * Unlike `create-user`, this is safe to run over and over: the first run creates the
 * account, and every run after that just resets its password back to the known value. So
 * whatever state the row is in, the script leaves you with a login you can rely on — which
 * is the whole point of a seed for a dev/test database.
 *
 * The credentials default to the throwaway pair below, but can be overridden from the
 * environment (handy for CI). The password still goes through `lib/password.ts`, so the
 * stored hash is the same shape the login path verifies.
 *
 *   TEST_USER_EMAIL / TEST_USER_PASSWORD   override the defaults
 *
 * This account is deliberately an ADMIN. It has to be, or it is useless on a fresh
 * database: create-user makes the first account an admin so that further users can be
 * created at all, and a seed that produced a powerless first user would be a dead end.
 * Because it is admin with a weak, well-known password, DO NOT run this against a
 * production database — it is a dev/test convenience, nothing more.
 */

const EMAIL = process.env.TEST_USER_EMAIL ?? "test@gmail.com";
const PASSWORD = process.env.TEST_USER_PASSWORD ?? "12345678";
const NAME = process.env.TEST_USER_NAME ?? "Test User";

async function main(): Promise<void> {
  // Mirrors the rule the API advertises (contract/src/auth.ts) and the other CLIs enforce.
  if (PASSWORD.length < 8) {
    console.error("TEST_USER_PASSWORD must be at least 8 characters.");
    process.exit(1);
  }

  const passwordHash = await hashPassword(PASSWORD);
  const existing = await UserModel.findByEmail(EMAIL);

  if (existing) {
    await UserModel.setPassword(existing.id, passwordHash);
    console.log(`✓ ${EMAIL} already existed (id ${existing.id}) — reset its password.`);
  } else {
    const user = await UserModel.create({
      email: EMAIL,
      passwordHash,
      name: NAME,
      roles: ["admin"],
    });
    console.log(`✓ Created ${user.email} (id ${user.id}) with the admin role.`);
  }

  console.log(`  Sign in at the frontend's /login with password: ${PASSWORD}`);
}

main()
  .catch((err) => {
    console.error("Failed to seed the test user:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await DBModel.closePool();
  });
