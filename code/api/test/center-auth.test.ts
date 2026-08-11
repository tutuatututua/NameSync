import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { DBModel } from "@extensions/sqldb";
import { buildApp } from "../src/app";
import { UserModel } from "../src/models";
import { resetThrottle } from "../src/services/auth.service";
import { resetTwoFactorStates } from "../src/lib/two-factor-state";

/**
 * Center sign-in (POST /api/auth/center/login).
 *
 * Center itself is never dialled — global `fetch` is stubbed to play Center's part, so these
 * tests pin the *contract* Network Intel depends on (2FA-as-an-error, the email/OTP branch, the
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
const UNKNOWN = "stranger@example.com"; // Center accepts them; Network Intel has no row.

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
    if (username === SMS_USER && !otp) return json({ error: "Require TOTP", error_description: "SMS-REF-9" }, 401);
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
    const match = /^networkintel_session=([^;]*)/.exec(header);
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
  // In-memory and per-process, like the throttle: without this, one test's sign-in would answer
  // the next test's "what do we know about this user".
  resetTwoFactorStates();
  // The Center path is throttled now (5 failures per email+IP per 15 min). It is in-memory and
  // per-process, so without this the wrong-password tests would poison whatever ran after them.
  resetThrottle();
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
    // Network Intel's own cookie — Center's token never reaches the browser or the body.
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

  it("returns an SMS challenge with a ref, asks Center to text the code, then completes", async () => {
    const first = await post({ email: SMS_USER, password: GOOD_PASSWORD });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().data).toMatchObject({ twoFactorRequired: true, method: "sms", ref: "SMS-REF-9" });
    expect(sendcodeCalls).toBe(1); // Center was asked to text the code
    expect(sessionCookie(first.headers["set-cookie"])).toBeFalsy();

    const second = await post({ email: SMS_USER, password: GOOD_PASSWORD, code: "987654", method: "sms", ref: "SMS-REF-9" });
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json().data.user.email).toBe(SMS_USER);
    expect(sessionCookie(second.headers["set-cookie"])).toBeTruthy();
  });

  it("401s a wrong password without revealing whether the account exists", async () => {
    const res = await post({ email: HAPPY, password: "nope" });
    expect(res.statusCode).toBe(401);
    expect(res.json().message).toMatch(/incorrect/i);
  });

  it("throttles repeated failures, and stops calling Center once it does", async () => {
    // This matters more than an ordinary rate limit. Center runs its OWN lockout (roughly five
    // tries, then fifteen minutes), so an unthrottled proxy would let anyone lock a real user
    // out of CENTER — not merely out of this app — by hammering this endpoint.
    const attempt = () => post({ email: HAPPY, password: "nope" });

    for (let i = 0; i < 5; i++) expect((await attempt()).statusCode).toBe(401);

    const callsBefore = (global.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    const blocked = await attempt();
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().message).toMatch(/too many/i);

    // The refusal happens BEFORE Center is dialled — which is the whole point. If it fired
    // afterwards it would have already spent one of the user's real Center attempts.
    expect((global.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(callsBefore);
  });

  it("does not count Center being unreachable against the user's allowance", async () => {
    // A 503 is not the caller's fault. Burning their five tries on our outage would lock
    // someone out of an app that was never rejecting them in the first place.
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "upstream boom" }, 500)));
    for (let i = 0; i < 6; i++) {
      const res = await post({ email: HAPPY, password: GOOD_PASSWORD });
      expect(res.statusCode, res.body).not.toBe(429);
    }
  });

  it("clears the throttle once a sign-in succeeds", async () => {
    for (let i = 0; i < 4; i++) expect((await post({ email: HAPPY, password: "nope" })).statusCode).toBe(401);
    expect((await post({ email: HAPPY, password: GOOD_PASSWORD })).statusCode).toBe(200);
    // The slate is clean: four more failures do not tip it over from the earlier four.
    for (let i = 0; i < 4; i++) expect((await post({ email: HAPPY, password: "nope" })).statusCode).toBe(401);
  });
});

/**
 * GET /api/auth/2fa/known — "am I protected?", answered without a password prompt.
 *
 * The reading is taken from the sign-in itself: Center demands a second factor exactly when the
 * account has one, so which endpoint the login had to go through IS the state. No Center call is
 * added for it, which is what these tests pin — that, and the fact that the answer arrives with
 * no re-auth window open, since the whole point is to let someone CHECK without re-authenticating.
 */
describe("2FA state, readable without a password prompt", () => {
  /** Sign in and return the session cookie. */
  async function signIn(payload: Record<string, unknown>): Promise<string> {
    const res = await post(payload);
    expect(res.statusCode, res.body).toBe(200);
    const cookie = sessionCookie(res.headers["set-cookie"]);
    expect(cookie).toBeTruthy();
    return cookie as string;
  }

  const known = (cookie: string) =>
    secured.inject({
      method: "GET",
      url: "/api/auth/2fa/known",
      headers: { cookie: `networkintel_session=${encodeURIComponent(cookie)}` },
    });

  it("reports 'none' after a sign-in Center accepted on the password alone", async () => {
    const cookie = await signIn({ email: HAPPY, password: GOOD_PASSWORD });

    const res = await known(cookie);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.method).toBe("none");
    // Dated, so the page can say how fresh the reading is rather than implying it is live.
    expect(Number.isNaN(Date.parse(res.json().data.checkedAt))).toBe(false);
  });

  it("reports the factor an authenticator account signed in with", async () => {
    const cookie = await signIn({
      email: TOTP_USER,
      password: GOOD_PASSWORD,
      code: "123456",
      method: "totp",
    });
    expect((await known(cookie)).json().data.method).toBe("totp");
  });

  it("reports an emailed code as protection, which the Center flag alone would call 'none'", async () => {
    // Center keeps email 2FA outside `flag_totp`, so status-totp answers "N" for this account.
    // Reading the state off the login instead is what keeps the page from telling someone who
    // just typed an emailed code that their account has no second factor.
    const cookie = await signIn({
      email: EMAIL_USER,
      password: GOOD_PASSWORD,
      code: "123456",
      method: "email",
      ref: "REF123",
    });
    expect((await known(cookie)).json().data.method).toBe("email");
  });

  it("says 'unknown' rather than guessing when this process never saw the sign-in", async () => {
    const cookie = await signIn({ email: HAPPY, password: GOOD_PASSWORD });
    resetTwoFactorStates(); // as an API restart would leave it

    const res = await known(cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ method: "unknown", checkedAt: null });
  });

  it("costs no extra Center call — the sign-in already answered it", async () => {
    const calls = () => (global.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    const cookie = await signIn({ email: HAPPY, password: GOOD_PASSWORD });

    const before = calls();
    expect((await known(cookie)).statusCode).toBe(200);
    expect(calls()).toBe(before);
  });

  it("401s when signed out — it is a read of the caller's own account, not a public fact", async () => {
    const res = await secured.inject({ method: "GET", url: "/api/auth/2fa/known" });
    expect(res.statusCode).toBe(401);
  });
});
