import { describe, it, expect } from "vitest";
import { hasFullAccess, isReviewerOnly } from "@extensions/contract";
import { mayAccess } from "../src/lib/roles";

/**
 * The `reviewer` boundary.
 *
 * These are pure function tests on purpose — no app, no database. The allowlist is the whole
 * security decision, so it should be provable without a running stack, and a regression here
 * should fail in milliseconds rather than behind a Postgres container.
 *
 * The cases that matter most are the counter-intuitive ones, and they are why this is an
 * allowlist rather than "reviewers may only send GET":
 *   - POST /api/db/sql is a READ, and must still be refused.
 *   - GET /api/db/tables and GET /api/upload-sessions are READS, and must still be refused.
 */

const REVIEWER = ["reviewer"];
const USER = ["user"];
const ADMIN = ["admin"];

describe("role predicates", () => {
  it("treats user and admin as full access, reviewer as not", () => {
    expect(hasFullAccess(USER)).toBe(true);
    expect(hasFullAccess(ADMIN)).toBe(true);
    expect(hasFullAccess(REVIEWER)).toBe(false);
  });

  it("does not call an account reviewer-only when it also holds a full-access role", () => {
    // A contradictory pairing resolves to full access, so it must NOT be treated as the
    // restricted view — otherwise the two checks would disagree about the same account.
    expect(isReviewerOnly(["reviewer", "user"])).toBe(false);
    expect(isReviewerOnly(REVIEWER)).toBe(true);
  });
});

describe("mayAccess — full-access roles", () => {
  it("lets user and admin reach everything the app exposes", () => {
    for (const roles of [USER, ADMIN]) {
      expect(mayAccess(roles, "GET", "/api/network/overview")).toBe(true);
      expect(mayAccess(roles, "POST", "/api/comparisons/compare")).toBe(true);
      expect(mayAccess(roles, "POST", "/api/db/sql")).toBe(true);
      expect(mayAccess(roles, "DELETE", "/api/comparisons/42")).toBe(true);
      expect(mayAccess(roles, "POST", "/api/upload-sessions/preview")).toBe(true);
    }
  });
});

describe("mayAccess — reviewer", () => {
  it("allows the Network workspace reads", () => {
    for (const path of ["overview", "grading", "uploaders", "uploader", "search"]) {
      expect(mayAccess(REVIEWER, "GET", `/api/network/${path}`)).toBe(true);
    }
  });

  it("ignores the query string when matching", () => {
    // Every one of these arrives with params in practice (?threshold=, ?company=, ?page=).
    expect(mayAccess(REVIEWER, "GET", "/api/network/search?q=somchai&page=1&limit=25")).toBe(true);
    expect(mayAccess(REVIEWER, "GET", "/api/network/overview?uploader=Ann&threshold=0.8")).toBe(true);
  });

  it("allows the run list and one run's stored results", () => {
    expect(mayAccess(REVIEWER, "GET", "/api/comparisons")).toBe(true);
    expect(mayAccess(REVIEWER, "GET", "/api/comparisons/abc123/progress")).toBe(true);
    expect(mayAccess(REVIEWER, "GET", "/api/comparisons/abc123/results")).toBe(true);
    expect(mayAccess(REVIEWER, "GET", "/api/comparisons/abc123/rows?page=2")).toBe(true);
  });

  it("allows managing only their own account", () => {
    expect(mayAccess(REVIEWER, "GET", "/api/auth/me")).toBe(true);
    expect(mayAccess(REVIEWER, "POST", "/api/auth/logout")).toBe(true);
    expect(mayAccess(REVIEWER, "POST", "/api/auth/change-password")).toBe(true);
    // Creating accounts is an admin power and stays one.
    expect(mayAccess(REVIEWER, "POST", "/api/auth/users")).toBe(false);
  });

  it("refuses reads that are POSTs — the reason this is not a method rule", () => {
    expect(mayAccess(REVIEWER, "POST", "/api/db/sql")).toBe(false);
    expect(mayAccess(REVIEWER, "POST", "/api/db/tables/friend/query")).toBe(false);
  });

  it("refuses GETs that belong to the Uploads and Data pages", () => {
    expect(mayAccess(REVIEWER, "GET", "/api/db/tables")).toBe(false);
    expect(mayAccess(REVIEWER, "GET", "/api/db/saved-queries")).toBe(false);
    expect(mayAccess(REVIEWER, "GET", "/api/upload-sessions")).toBe(false);
  });

  it("refuses everything that adds, changes or removes data", () => {
    expect(mayAccess(REVIEWER, "POST", "/api/comparisons/compare")).toBe(false);
    expect(mayAccess(REVIEWER, "POST", "/api/comparisons/run")).toBe(false);
    expect(mayAccess(REVIEWER, "DELETE", "/api/comparisons/abc123")).toBe(false);
    expect(mayAccess(REVIEWER, "PATCH", "/api/comparisons/abc123")).toBe(false);
    expect(mayAccess(REVIEWER, "POST", "/api/upload-sessions/preview")).toBe(false);
    expect(mayAccess(REVIEWER, "POST", "/api/upload-sessions/7/rollback")).toBe(false);
    expect(mayAccess(REVIEWER, "PATCH", "/api/comparisons/company-data/abc")).toBe(false);
    expect(mayAccess(REVIEWER, "DELETE", "/api/comparisons/company-data/all")).toBe(false);
    expect(mayAccess(REVIEWER, "POST", "/api/upload-sources")).toBe(false);
    expect(mayAccess(REVIEWER, "DELETE", "/api/upload-sources/facebook")).toBe(false);
  });

  it("does not let a sibling path slip through the run-id pattern", () => {
    // `[^/]+` is the id; these share the prefix but are different endpoints entirely, and a
    // sloppier regex would hand a reviewer the full company/friend exports.
    expect(mayAccess(REVIEWER, "GET", "/api/comparisons/duplicate")).toBe(false);
    expect(mayAccess(REVIEWER, "GET", "/api/comparisons/companies")).toBe(false);
    expect(mayAccess(REVIEWER, "GET", "/api/comparisons/data-stats")).toBe(false);
    expect(mayAccess(REVIEWER, "GET", "/api/comparisons/company-data/all")).toBe(false);
    expect(mayAccess(REVIEWER, "GET", "/api/comparisons/facebook-data/all")).toBe(false);
    expect(mayAccess(REVIEWER, "GET", "/api/comparisons/abc123/company-data")).toBe(false);
  });

  it("is not fooled by a path that merely starts with an allowed one", () => {
    expect(mayAccess(REVIEWER, "GET", "/api/network/overview/secret")).toBe(false);
    expect(mayAccess(REVIEWER, "GET", "/api/comparisons/extra")).toBe(false);
    expect(mayAccess(REVIEWER, "GET", "/api/upload-sources/facebook")).toBe(false);
  });

  it("matches the method exactly", () => {
    // Same path, wrong verb: /api/comparisons is readable but must not be writable.
    expect(mayAccess(REVIEWER, "POST", "/api/comparisons")).toBe(false);
    expect(mayAccess(REVIEWER, "DELETE", "/api/network/search")).toBe(false);
  });

  it("accepts a lowercase method, since that is what some clients send", () => {
    expect(mayAccess(REVIEWER, "get", "/api/network/overview")).toBe(true);
  });
});

describe("mayAccess — accounts with no meaningful role", () => {
  it("refuses everything rather than falling through to full access", () => {
    // The failure direction that matters: a typo'd or emptied roles array must lock the
    // account out, not silently promote it.
    for (const roles of [[], ["reviewers"], ["Admin"], ["viewer"]]) {
      expect(mayAccess(roles, "GET", "/api/network/overview")).toBe(false);
      expect(mayAccess(roles, "GET", "/api/auth/me")).toBe(false);
      expect(mayAccess(roles, "POST", "/api/db/sql")).toBe(false);
    }
  });
});
