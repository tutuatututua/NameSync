import "dotenv/config";
import { DBModel } from "@extensions/sqldb";
import { createUser } from "../services/auth.service";
import { UserModel } from "../models";

/**
 * Create a user from the command line.
 *
 *   npm run create-user -- you@example.com --name "Your Name" --admin
 *   npm run create-user -- them@example.com --reviewer
 *
 * NO PASSWORD. Center holds the credential; a row here only says which Center identity is
 * allowed in, and with what role. Creating an account does NOT create a Center account —
 * the person must already be able to sign in to Center with this exact email.
 *
 * This exists because there is no public sign-up — Network Intel is an internal tool, and an
 * open /register would put the data behind nothing at all. So the first account has to be
 * made out-of-band, and it has to be an admin, or nobody can ever create the second one.
 *
 * After the first admin exists, further users are better made through the API
 * (POST /api/auth/users), which requires an admin session.
 *
 * ROLES (see extensions/contract/src/auth.ts and api/src/lib/roles.ts):
 *   --admin     everything, plus creating further accounts
 *   (default)   `user` — everything except account creation
 *   --reviewer  the Network page, read-only: no imports, no matcher runs, no edits
 */

interface Args {
  email: string;
  name?: string;
  admin: boolean;
  reviewer: boolean;
}

function parseArgs(argv: string[]): Args | null {
  const positional: string[] = [];
  let name: string | undefined;
  let admin = false;
  let reviewer = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--admin") admin = true;
    else if (arg === "--reviewer") reviewer = true;
    else if (arg === "--name") name = argv[++i];
    else if (arg.startsWith("--name=")) name = arg.slice("--name=".length);
    else if (arg.startsWith("--")) {
      console.error(`Unknown option: ${arg}`);
      return null;
    } else positional.push(arg);
  }

  const [email] = positional;
  if (!email) return null;
  // Contradictory rather than additive: `reviewer` is a RESTRICTION, and an account holding
  // both would silently be a full-access account (hasFullAccess wins), which is the opposite
  // of what whoever typed --reviewer meant.
  if (admin && reviewer) {
    console.error("--admin and --reviewer are mutually exclusive: a reviewer is read-only by definition.");
    return null;
  }
  return { email, name, admin, reviewer };
}

function usage(): never {
  console.error(
    [
      "Usage: npm run create-user -- <email> [--name \"Full Name\"] [--admin | --reviewer]",
      "",
      "  No password: Center holds the credential. This only authorises a Center identity,",
      "  so the email must be one that can already sign in to Center.",
      "",
      "  --admin      the whole app, plus creating further users via the API",
      "  --reviewer   the Network page, READ ONLY — no imports, no matcher runs, no edits",
      "  (neither)    the 'user' role: the whole app, but cannot create accounts",
      "",
      "The FIRST user must be an --admin, or no one will be able to create any others.",
    ].join("\n")
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args) usage();

  const first = (await UserModel.countAll()) === 0;
  if (first && !args.admin) {
    console.error(
      "This is the first user, so it must be an admin — otherwise no one can create any others.\n" +
        "Re-run with --admin."
    );
    process.exit(1);
  }

  if (await UserModel.findByEmail(args.email)) {
    console.error(`A user with the email ${args.email} already exists.`);
    process.exit(1);
  }

  // Exactly one role, always. This used to hand a non-admin `[]`, which was harmless when
  // nothing consulted roles — but now that lib/roles.ts default-denies, an empty array is an
  // account that can sign in and reach nothing at all.
  const roles = args.admin ? ["admin"] : args.reviewer ? ["reviewer"] : ["user"];

  // Through the service, so the CLI and POST /api/auth/users create identical rows —
  // including the unusable random password_hash that satisfies the NOT NULL column.
  const user = await createUser({ email: args.email, name: args.name, roles });

  console.log(`✓ Created user ${user.email} (id ${user.sub}) with the ${roles[0]} role.`);
  if (args.reviewer) {
    console.log("  Read-only: the Network page and what it links to. No imports, runs or edits.");
  }
  console.log("  They sign in at /login with their CENTER password — none is stored here.");
}

main()
  .catch((err) => {
    console.error("Failed to create the user:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await DBModel.closePool();
  });
