import { beforeAll, afterAll, describe, it, expect } from "vitest";
import type { FastifyInstance } from "fastify";
import { DBModel } from "@extensions/sqldb";
import { buildApp } from "../src/app";
import { UserModel } from "../src/models";
import { hashPassword } from "../src/lib/password";
import { login } from "../src/services/auth.service";

/**
 * The reviewer boundary, over real HTTP.
 *
 * test/roles.test.ts proves the allowlist function. This proves it is actually WIRED — that a
 * genuine reviewer session, carrying a genuine cookie, is refused by the running app. The two
 * fail differently: get the regex wrong and roles.test.ts catches it; forget to call
 * mayAccess() from the onRequest hook and only this catches it.
 *
 * Every request here goes through the same hook a browser would, so a 403 is the server's
 * answer and not the UI declining to draw a button.
 */

const PASSWORD = "correct-horse-battery-staple";
const REVIEWER = "reviewer@example.com";
const FULL = "full-user@example.com";

let app: FastifyInstance;
let reviewerToken: string;
let userToken: string;

/** As the reviewer. Bearer, because that is the scripted equivalent of their cookie. */
const asReviewer = (method: string, url: string) =>
  app.inject({ method: method as "GET", url, headers: { authorization: `Bearer ${reviewerToken}` } });

const asUser = (method: string, url: string) =>
  app.inject({ method: method as "GET", url, headers: { authorization: `Bearer ${userToken}` } });

beforeAll(async () => {
  // Auth on for this app (the suite's default runs with AUTH_DISABLED=1, which would make
  // every request an admin and quietly render this whole file meaningless).
  delete process.env.AUTH_DISABLED;
  app = await buildApp();
  process.env.AUTH_DISABLED = "1";

  await UserModel.create({
    email: REVIEWER,
    passwordHash: await hashPassword(PASSWORD),
    name: "Reviewer",
    roles: ["reviewer"],
  });
  await UserModel.create({
    email: FULL,
    passwordHash: await hashPassword(PASSWORD),
    name: "Full User",
    roles: ["user"],
  });

  reviewerToken = (await login(REVIEWER, PASSWORD)).token;
  userToken = (await login(FULL, PASSWORD)).token;
});

afterAll(async () => {
  await app?.close();
  const db = await DBModel.getKyselyDB();
  await db.deleteFrom("app_user").where("email", "in", [REVIEWER, FULL]).execute();
});

describe("a reviewer session", () => {
  it("is signed in and reports the reviewer role", async () => {
    const res = await asReviewer("GET", "/api/auth/me");
    expect(res.statusCode).toBe(200);
    expect(res.json().data.user.roles).toEqual(["reviewer"]);
  });

  it("can read the Network workspace", async () => {
    for (const url of ["/api/network/overview", "/api/network/grading", "/api/network/uploaders"]) {
      expect((await asReviewer("GET", url)).statusCode, url).toBe(200);
    }
  });

  it("can list runs", async () => {
    expect((await asReviewer("GET", "/api/comparisons")).statusCode).toBe(200);
  });

  it("is refused the Data console — including the read-only SQL endpoint", async () => {
    // The one that a "reviewers may only GET" rule would have let through.
    const sql = await asReviewer("POST", "/api/db/sql");
    expect(sql.statusCode).toBe(403);
    expect((await asReviewer("GET", "/api/db/tables")).statusCode).toBe(403);
  });

  it("is refused the Uploads page's data", async () => {
    expect((await asReviewer("GET", "/api/upload-sessions")).statusCode).toBe(403);
  });

  it("is refused starting a matcher run", async () => {
    expect((await asReviewer("POST", "/api/comparisons/compare")).statusCode).toBe(403);
  });

  it("is refused deleting a run", async () => {
    expect((await asReviewer("DELETE", "/api/comparisons/some-id")).statusCode).toBe(403);
  });

  it("is refused creating accounts", async () => {
    expect((await asReviewer("POST", "/api/auth/users")).statusCode).toBe(403);
  });

  it("answers 403 and not 404 for a blocked route, so the boundary is unambiguous", async () => {
    const res = await asReviewer("GET", "/api/db/tables");
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("FORBIDDEN");
  });
});

describe("a full-access session, for contrast", () => {
  it("reaches what the reviewer cannot", async () => {
    expect((await asUser("GET", "/api/db/tables")).statusCode).toBe(200);
    expect((await asUser("GET", "/api/upload-sessions")).statusCode).toBe(200);
  });

  it("is still refused creating accounts, which stays admin-only", async () => {
    // `user` is full app access, NOT account management — the one check that predates this
    // layer must not have been widened by it.
    //
    // A VALID body is required to prove this: the role hook runs onRequest, but the admin
    // check lives in the handler, behind schema validation. An empty payload would 400 on
    // the way in and the test would pass without ever reaching the gate it claims to test.
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/users",
      headers: { authorization: `Bearer ${userToken}` },
      payload: { email: "nope@example.com", password: "correct-horse-battery-staple" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toMatch(/admin/i);
  });
});
