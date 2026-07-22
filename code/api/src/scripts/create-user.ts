import "dotenv/config";
import { DBModel } from "@extensions/sqldb";
import { UserModel } from "../models";
import { hashPassword } from "../lib/password";

/**
 * Create a user from the command line.
 *
 *   npm run create-user -- you@example.com 'a long passphrase' --name "Your Name" --admin
 *
 * This exists because there is no public sign-up — Network Intel is an internal tool, and an
 * open /register would put the data behind nothing at all. So the first account has to be
 * made out-of-band, and it has to be an admin, or nobody can ever create the second one.
 *
 * After the first admin exists, further users are better made through the API
 * (POST /api/auth/users), which requires an admin session.
 */

interface Args {
  email: string;
  password: string;
  name?: string;
  admin: boolean;
}

function parseArgs(argv: string[]): Args | null {
  const positional: string[] = [];
  let name: string | undefined;
  let admin = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--admin") admin = true;
    else if (arg === "--name") name = argv[++i];
    else if (arg.startsWith("--name=")) name = arg.slice("--name=".length);
    else if (arg.startsWith("--")) {
      console.error(`Unknown option: ${arg}`);
      return null;
    } else positional.push(arg);
  }

  const [email, password] = positional;
  if (!email || !password) return null;
  return { email, password, name, admin };
}

function usage(): never {
  console.error(
    [
      "Usage: npm run create-user -- <email> <password> [--name \"Full Name\"] [--admin]",
      "",
      "  --admin   grant the 'admin' role (required to create further users via the API)",
      "",
      "The FIRST user must be an --admin, or no one will be able to create any others.",
    ].join("\n")
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args) usage();

  // Mirrors the API's own rule (contract/src/auth.ts). Enforced here too: a CLI that
  // quietly accepts "hunter2" would make a liar of the rule the endpoint advertises.
  if (args.password.length < 8) {
    console.error("Password must be at least 8 characters.");
    process.exit(1);
  }

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

  const user = await UserModel.create({
    email: args.email,
    passwordHash: await hashPassword(args.password),
    name: args.name ?? null,
    roles: args.admin ? ["admin"] : [],
  });

  console.log(`✓ Created user ${user.email} (id ${user.id})${args.admin ? " with the admin role" : ""}.`);
  console.log("  Sign in at the frontend's /login.");
}

main()
  .catch((err) => {
    console.error("Failed to create the user:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await DBModel.closePool();
  });
