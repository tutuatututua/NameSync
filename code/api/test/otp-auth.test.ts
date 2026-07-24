import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { DBModel } from "@extensions/sqldb";
import { hashPassword } from "../src/lib/password";

/**
 * Email one-time-code sign-in (POST /api/auth/otp/login).
 *
 * The mailer is mocked so nothing leaves the process — instead each "sent" code is captured
 * here, which is exactly what the real user reads out of their inbox. That lets the two-step
 * flow be driven end to end: step one produces a code, the test reads it, step two spends it.
 */

// vi.hoisted so the factory below can see `sent` despite vi.mock being hoisted above imports.
const { sent } = vi.hoisted(() => ({ sent: [] as { to: string; code: string }[] }));
vi.mock("../src/lib/mailer", () => ({
  sendLoginCode: async (to: string, code: string) => {
    sent.push({ to, code });
  },
}));

import { buildApp } from "../src/app";
import { UserModel } from "../src/models";
import { resetThrottle } from "../src/services/auth.service";

const PASSWORD = "correct-horse-battery-staple";
const USER = "otp-user@example.com";
const UNKNOWN = "nobody@example.com";

let secured: FastifyInstance;

const post = (payload: unknown) =>
  secured.inject({ method: "POST", url: "/api/auth/otp/login", payload });

function sessionCookie(setCookie: string | string[] | undefined): string | undefined {
  const headers = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  for (const header of headers) {
    const match = /^networkintel_session=([^;]*)/.exec(header);
    if (match && match[1]) return decodeURIComponent(match[1]);
  }
  return undefined;
}

beforeAll(async () => {
  // Auth on for this app (the suite's default runs with AUTH_DISABLED=1).
  delete process.env.AUTH_DISABLED;
  secured = await buildApp();
  process.env.AUTH_DISABLED = "1";

  await UserModel.create({
    email: USER,
    passwordHash: await hashPassword(PASSWORD),
    name: "OTP User",
    roles: ["admin"],
  });
});

afterAll(async () => {
  await secured?.close();
  const db = await DBModel.getKyselyDB();
  await db.deleteFrom("app_user").where("email", "=", USER).execute();
});

beforeEach(() => {
  sent.length = 0;
  resetThrottle(); // the throttle is per email+ip and in-memory; don't let it bleed across tests
});

describe("Email OTP sign-in", () => {
  it("step one: right password emails a code and returns a challenge, no cookie yet", async () => {
    const res = await post({ email: USER, password: PASSWORD });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toMatchObject({ twoFactorRequired: true, method: "email" });
    expect(res.json().data.ref).toBeTruthy();
    expect(sessionCookie(res.headers["set-cookie"])).toBeFalsy();
    // A code actually went to the account's own address.
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(USER);
    expect(sent[0].code).toMatch(/^\d{6}$/);
  });

  it("step two: the emailed code completes sign-in and sets an httpOnly cookie", async () => {
    const first = await post({ email: USER, password: PASSWORD });
    const ref = first.json().data.ref as string;
    const code = sent[0].code;

    const second = await post({ email: USER, password: PASSWORD, code, ref });
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json().data.user.email).toBe(USER);
    const cookie = sessionCookie(second.headers["set-cookie"]);
    expect(cookie).toBeTruthy();
    const header = ([] as string[]).concat(second.headers["set-cookie"] as string).join(";");
    expect(header).toMatch(/HttpOnly/i);
  });

  it("a code cannot be spent twice", async () => {
    const first = await post({ email: USER, password: PASSWORD });
    const ref = first.json().data.ref as string;
    const code = sent[0].code;

    const ok = await post({ email: USER, password: PASSWORD, code, ref });
    expect(ok.statusCode).toBe(200);

    const replay = await post({ email: USER, password: PASSWORD, code, ref });
    expect(replay.statusCode).toBe(401);
    expect(sessionCookie(replay.headers["set-cookie"])).toBeFalsy();
  });

  it("a wrong code is refused, and burns out after the attempt cap", async () => {
    const first = await post({ email: USER, password: PASSWORD });
    const ref = first.json().data.ref as string;
    const realCode = sent[0].code;

    // Five wrong guesses (the default cap). Each re-sends the correct password, so this is the
    // OTP cap being tested, not the credential throttle.
    for (let i = 0; i < 5; i++) {
      const bad = await post({ email: USER, password: PASSWORD, code: "000000", ref });
      expect(bad.statusCode).toBe(401);
    }
    // Now even the *correct* code is dead — the row is burned.
    const tooLate = await post({ email: USER, password: PASSWORD, code: realCode, ref });
    expect(tooLate.statusCode).toBe(401);
    expect(sessionCookie(tooLate.headers["set-cookie"])).toBeFalsy();
  });

  it("requesting a second code invalidates the first", async () => {
    const first = await post({ email: USER, password: PASSWORD });
    const firstRef = first.json().data.ref as string;
    const firstCode = sent[0].code;

    // A fresh request — the old code should now be worthless.
    await post({ email: USER, password: PASSWORD });

    const stale = await post({ email: USER, password: PASSWORD, code: firstCode, ref: firstRef });
    expect(stale.statusCode).toBe(401);
  });

  it("wrong password never emails a code, and answers like an unknown account", async () => {
    const wrong = await post({ email: USER, password: "not-the-password" });
    expect(wrong.statusCode).toBe(401);
    expect(sent).toHaveLength(0);

    const unknown = await post({ email: UNKNOWN, password: "whatever-1234" });
    expect(unknown.statusCode).toBe(401);
    expect(sent).toHaveLength(0);
    // Same message either way — no user-enumeration oracle.
    expect(unknown.json().message).toBe(wrong.json().message);
  });
});
