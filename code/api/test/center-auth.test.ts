import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { DBModel } from "@extensions/sqldb";
import { buildApp } from "../src/app";
import { UserModel } from "../src/models";

/**
 * Center sign-in (POST /api/auth/center/login).
 *
 * Center itself is never dialled — global `fetch` is stubbed to play Center's part, so these
 * tests pin the *contract* NameSync depends on (2FA-as-an-error, the email/OTP branch, the
 * match-or-reject rule) without a live centerapp.io. The base URL is set in test/setup.ts.
 *
 * The stub encodes the signed-in email into the token it returns (`tok:<email>`) so `auth/me`
 * can hand it back — that is how the happy path and the "not authorised" path diverge.
 */

const GOOD_PASSWORD = "correct-horse";
const HAPPY = "happy@example.com";
const TOTP_USER = "totp@example.com";
const EMAIL_USER = "email2fa@example.com";
const SMS_USER = "sms@example.com";
const UNKNOWN = "stranger@example.com"; // Center accepts them; NameSync has no row.

let secured: FastifyInstance;
let sendcodeCalls = 0;
const realFetch = global.fetch;

/** A JSON Response, the way Center answers. */
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

/** Center, in miniature: the login/2FA/me/sendcode behaviour lib/center.ts is written against. */
function centerStub(url: string, init?: RequestInit): Response {
  const body = init?.body ? JSON.parse(String(init.body)) : {};

  if (url.endsWith("/auth/login")) {
    const { username, password, totp, otp } = body as Record<string, string>;
    if (password !== GOOD_PASSWORD) return json({ error: "Invalid Username or Password life:4" }, 401);
    if (username === TOTP_USER && !totp) return json({ error: "Require TOTP", error_description: "" }, 401);
    if (username === EMAIL_USER && !otp) return json({ error: "Require TOTP", error_description: "email:REF123" }, 401);
    if (username === SMS_USER) return json({ error: "Require TOTP", error_description: "SMS-REF-9" }, 401);
    return json({ token: `tok:${username}`, tokenType: "Bearer", expiresDate: "2099-01-01" }, 200);
  }
  if (url.endsWith("/auth/me")) {
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    const token = auth.replace(/^Bearer\s+/i, "");
    const email = token.startsWith("tok:") ? token.slice(4) : null;
    return json({ email, name: "Center User" }, 200);
  }
  if (url.endsWith("/auth/sendcode")) {
    sendcodeCalls += 1;
    return json({ success: true }, 200);
  }
  return json({}, 404);
}

const post = (payload: unknown) =>
  secured.inject({ method: "POST", url: "/api/auth/center/login", payload });

function sessionCookie(setCookie: string | string[] | undefined): string | undefined {
  const headers = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  for (const header of headers) {
    const match = /^namesync_session=([^;]*)/.exec(header);
    if (match && match[1]) return decodeURIComponent(match[1]);
  }
  return undefined;
}

beforeAll(async () => {
  // Auth on for this app (the suite's default app runs with AUTH_DISABLED=1).
  delete process.env.AUTH_DISABLED;
  secured = await buildApp();
  process.env.AUTH_DISABLED = "1";

  for (const email of [HAPPY, TOTP_USER, EMAIL_USER, SMS_USER]) {
    await UserModel.create({ email, passwordHash: "x", name: "Center User", roles: ["admin"] });
  }
});

afterAll(async () => {
  await secured?.close();
  const db = await DBModel.getKyselyDB();
  await db
    .deleteFrom("app_user")
    .where("email", "in", [HAPPY, TOTP_USER, EMAIL_USER, SMS_USER])
    .execute();
});

beforeEach(() => {
  sendcodeCalls = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
    centerStub(String(input), init)
  ));
});

afterEach(() => {
  vi.stubGlobal("fetch", realFetch);
});

describe("Center sign-in", () => {
  it("signs in a known user and sets an httpOnly session cookie", async () => {
    const res = await post({ email: HAPPY, password: GOOD_PASSWORD });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.user.email).toBe(HAPPY);
    // NameSync's own cookie — Center's token never reaches the browser or the body.
    expect(res.body).not.toContain("tok:");
    expect(sessionCookie(res.headers["set-cookie"])).toBeTruthy();
    const header = ([] as string[]).concat(res.headers["set-cookie"] as string).join(";");
    expect(header).toMatch(/HttpOnly/i);
  });

  it("rejects a Center user with no app_user row (authenticated, not authorised)", async () => {
    const res = await post({ email: UNKNOWN, password: GOOD_PASSWORD });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toMatch(/isn't authorised|not authorised|administrator/i);
    expect(sessionCookie(res.headers["set-cookie"])).toBeFalsy();
  });

  it("returns a TOTP challenge, then completes on the second call with the code", async () => {
    const first = await post({ email: TOTP_USER, password: GOOD_PASSWORD });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().data).toMatchObject({ twoFactorRequired: true, method: "totp", ref: null });
    expect(sessionCookie(first.headers["set-cookie"])).toBeFalsy();

    const second = await post({ email: TOTP_USER, password: GOOD_PASSWORD, code: "123456", method: "totp" });
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json().data.user.email).toBe(TOTP_USER);
    expect(sessionCookie(second.headers["set-cookie"])).toBeTruthy();
  });

  it("returns an email challenge with a ref, and asks Center to send the code", async () => {
    const res = await post({ email: EMAIL_USER, password: GOOD_PASSWORD });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toMatchObject({ twoFactorRequired: true, method: "email", ref: "REF123" });
    expect(sendcodeCalls).toBe(1); // the code was actually requested
  });

  it("refuses an SMS-2FA account with a clear message", async () => {
    const res = await post({ email: SMS_USER, password: GOOD_PASSWORD });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/SMS/i);
  });

  it("401s a wrong password without revealing whether the account exists", async () => {
    const res = await post({ email: HAPPY, password: "nope" });
    expect(res.statusCode).toBe(401);
    expect(res.json().message).toMatch(/incorrect/i);
  });
});
