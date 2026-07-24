import "dotenv/config";
import { DBModel } from "@extensions/sqldb";
import { signInWithCenter } from "../services/center-auth.service";

/**
 * Temp diagnostic: exercise the REAL Center sign-in end to end for one account.
 * This makes a live call to centerapp.io; on full success it mints a Network Intel session
 * (writes an auth_session row + stamps last_login), exactly as POST /api/auth/center/login would.
 * Password is read from the env so it is never written to a file.
 */
async function main(): Promise<void> {
  const email = "warinthon.p@avlgb.com";
  const password = process.env.CENTER_TEST_PASSWORD ?? "";
  if (!password) {
    console.error("CENTER_TEST_PASSWORD env var is empty");
    process.exit(1);
  }

  console.log(`Attempting Center sign-in for ${email} …\n`);
  try {
    const result = await signInWithCenter({ email, password });
    if (result.kind === "twoFactor") {
      console.log("→ Center requires a SECOND FACTOR before a session is issued:");
      console.log("   method:", result.challenge.method);
      console.log("   ref   :", result.challenge.ref ?? "(none — authenticator app)");
      if (result.challenge.method === "email") {
        console.log(`   (a code was just emailed to ${email} — re-run with the code to finish)`);
      } else {
        console.log("   (enter the current 6-digit code from the authenticator app to finish)");
      }
    } else {
      const u = result.session.user;
      console.log("✓ CENTER LOGIN SUCCEEDED — Network Intel session issued.");
      console.log("   user:", { sub: u.sub, email: u.email, name: u.name ?? null, roles: u.roles });
      console.log("   session expires:", result.session.expiresAt.toISOString());
    }
  } catch (e) {
    console.log("✗ Center login did NOT succeed:");
    console.log("  ", e instanceof Error ? `${e.constructor.name}: ${e.message}` : e);
  }
}

main()
  .catch((err) => {
    console.error("check failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await DBModel.closePool();
  });
