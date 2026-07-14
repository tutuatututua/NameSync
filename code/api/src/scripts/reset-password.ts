import "dotenv/config";
import { DBModel } from "@extensions/sqldb";
import { AuthSessionModel, UserModel } from "../models";
import { hashPassword } from "../lib/password";

/**
 * Reset an existing user's password from the command line.
 *
 *   npm run reset-password -- you@example.com 'a new passphrase'
 *
 * `create-user` deliberately refuses an email that already exists, which leaves no way back in
 * when the only admin's password is lost or changed out from under them — the API's own
 * change-password requires a session, and a session is exactly what you haven't got. This is
 * that way back in, and it is a CLI rather than an endpoint for the same reason create-user is:
 * an HTTP route that resets a password without a session is an open door.
 *
 * It hashes through `lib/password.ts`, so the stored value is the same shape the login path
 * verifies (scrypt, parameters travelling with the hash). Writing the column by hand — with a
 * hash from anywhere else — is how you get an account that exists and can never sign in.
 */

async function main(): Promise<void> {
  const [email, password] = process.argv.slice(2);

  if (!email || !password) {
    console.error("Usage: npm run reset-password -- <email> '<new password>'");
    process.exit(1);
  }

  // The API advertises an 8-character minimum (contract/src/auth.ts). A CLI that quietly
  // accepted less would make a liar of the rule the endpoint enforces.
  if (password.length < 8) {
    console.error("Password must be at least 8 characters.");
    process.exit(1);
  }

  const user = await UserModel.findByEmail(email);
  if (!user) {
    // Named plainly: this is an operator at a terminal who already knows the account exists,
    // not an anonymous request that could use the answer to enumerate users.
    console.error(`No user with the email ${email}.`);
    process.exit(1);
  }

  await UserModel.setPassword(user.id, await hashPassword(password));

  // Every existing session is now a session nobody asked for. A password reset is what you do
  // *because* you think someone else may be holding one — leaving them alive would defeat the
  // point of the reset. This mirrors change-password, which revokes the caller's own session too.
  const revoked = await AuthSessionModel.deleteAllForUser(user.id);

  console.log(`✓ Reset the password for ${user.email} (id ${user.id}).`);
  console.log(`  Revoked ${revoked} existing session(s) — everyone must sign in again.`);
}

main()
  .catch((err) => {
    console.error("Failed to reset the password:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await DBModel.closePool();
  });
