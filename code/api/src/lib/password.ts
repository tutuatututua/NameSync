import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

/**
 * Password hashing, on Node's built-in scrypt.
 *
 * scrypt rather than bcrypt/argon2 deliberately: those are native addons that have to be
 * compiled per platform, and this repo is developed on Windows and deployed in Docker.
 * scrypt is memory-hard, in the standard library, and needs no toolchain.
 *
 * A stored hash is self-describing:
 *
 *   scrypt$16384$8$1$<salt-b64>$<key-b64>
 *          N    r p
 *
 * The cost parameters travel with each hash, so raising them later re-hashes new and
 * changed passwords while every existing row still verifies against its own parameters.
 * Never compare these strings with ===; verifyPassword does a timing-safe compare.
 */

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number }
) => Promise<Buffer>;

// N=16384, r=8 => ~16MB per hash. maxmem must exceed 128*N*r or scrypt throws.
const N = 16_384;
const R = 8;
const P = 1;
const KEY_LEN = 64;
const SALT_LEN = 16;
const maxmemFor = (n: number, r: number) => 256 * n * r; // 2x the requirement, per Node's docs

/**
 * Unicode-normalise before hashing. "é" can be typed as one code point or as e + accent;
 * they look identical, so a password set on one keyboard must verify from another.
 */
const norm = (password: string): string => password.normalize("NFKC");

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const key = await scrypt(norm(password), salt, KEY_LEN, { N, r: R, p: P, maxmem: maxmemFor(N, R) });
  return ["scrypt", N, R, P, salt.toString("base64"), key.toString("base64")].join("$");
}

/**
 * Verify a password against a stored hash. Returns false — never throws — for a malformed
 * or unrecognised hash, so one corrupt row can't 500 the login endpoint.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const [, nRaw, rRaw, pRaw, saltB64, keyB64] = parts;
  const n = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  // Refuse absurd parameters rather than letting a doctored row allocate gigabytes.
  if (n < 1024 || n > 1 << 20 || r < 1 || r > 32 || p < 1 || p > 16) return false;

  let expected: Buffer;
  let salt: Buffer;
  try {
    expected = Buffer.from(keyB64, "base64");
    salt = Buffer.from(saltB64, "base64");
  } catch {
    return false;
  }
  if (expected.length === 0 || salt.length === 0) return false;

  let actual: Buffer;
  try {
    actual = await scrypt(norm(password), salt, expected.length, { N: n, r, p, maxmem: maxmemFor(n, r) });
  } catch {
    return false;
  }

  // Lengths are equal by construction (we derived `actual` at `expected.length`), but
  // timingSafeEqual throws on a mismatch, so keep the guard.
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/**
 * A real hash of a random secret, used to burn the same CPU time when the email doesn't
 * exist as when it does. Without it, "unknown user" returns in ~0ms and "wrong password"
 * in ~80ms, and that gap is a free user-enumeration oracle for anyone with a stopwatch.
 */
export const DUMMY_HASH: Promise<string> = hashPassword(randomBytes(32).toString("hex"));
