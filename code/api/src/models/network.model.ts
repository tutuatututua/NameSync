import { DBModel } from "@extensions/sqldb";
import { sql, type SqlBool } from "kysely";
import type {
  CompanyConnection,
  NameSearchRow,
  PaginatedResult,
  UploaderStats,
  UploaderDetailData,
} from "@extensions/contract";
import { rowVerdictSql } from "./row-status";

/**
 * The Network workspace's read side — Overview (Feature 1) and Search (Feature 2).
 *
 * Both read `comparison_result` and never run the matcher: a connection is a match some past run
 * already recorded. `status` is folded through `rowVerdictSql` for the same reason every other
 * reader does — the column is unconstrained and an external matcher spells "match" how it likes,
 * so a raw equality test would miscount. A company is grouped case-insensitively (`lower(...)` +
 * `min(...)` for the surviving spelling), exactly as `CompanyContactModel.distinctCompanies` does,
 * so the picker, the Overview and Search all agree on what one company is.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/** `%` and `_` are ILIKE wildcards — a search for a literal one must not widen the match. */
const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (m) => `\\${m}`);

/** "Is this comparison_result row a match?", over an arbitrarily-aliased status column. */
const matchedFor = (statusColumn: string) => sql`${rowVerdictSql(statusColumn)} = ${sql.val("matched")}`;

/** The same, typed as a boolean for a top-level `.where(...)` on `comparison_result`. */
const matched = (): ReturnType<typeof sql<SqlBool>> =>
  sql<SqlBool>`${rowVerdictSql("comparison_result.status")} = ${sql.val("matched")}`;

export class NetworkModel extends DBModel {
  /**
   * Every uploader who has uploaded friends — the Overview picker's options.
   *
   * Sourced from `upload.uploaded_by` (social imports), not from results, so an uploader who has a
   * friend list but has never been compared still appears: their roster size is a real answer
   * ("you uploaded 40 friends") even with zero connections yet. Folded by case, one spelling per name.
   */
  static async uploaders(): Promise<string[]> {
    const db = await this.getKyselyDB();
    const rows = await db
      .selectFrom("upload")
      .select(sql<string>`min(uploaded_by)`.as("name"))
      .where("kind", "=", "social")
      .where("uploaded_by", "is not", null)
      .groupBy(sql`lower(uploaded_by)`)
      .orderBy(sql`min(uploaded_by) asc`)
      .execute();
    return (rows as any[]).map((r) => r.name);
  }

  /**
   * Every uploader's roster size and how it landed — the Uploaders tab.
   *
   * `friends` counts the roster (friend rows for that uploader); `matched` is how many distinct
   * friend names matched anywhere; `noMatch = friends − matched`. This is the same definition the
   * Overview uses for one roster, computed here for all of them at once, so the tab and the
   * per-roster tiles agree.
   *
   * Two grouped aggregates merged by folded name, not one join: the roster lives in `friend`/
   * `upload` and the matches in `comparison_result`, and an uploader with a roster but zero matches
   * must still appear (matched 0) — an inner join would silently drop exactly the rosters the user
   * most wants to see ("who have I found nobody for yet"). Folded by case, one display spelling each.
   */
  static async uploaderStats(): Promise<UploaderStats[]> {
    const db = await this.getKyselyDB();

    const [friendRows, matchedRows] = await Promise.all([
      db
        .selectFrom("friend")
        .innerJoin("upload", "upload.id", "friend.upload_id")
        .select([
          sql<string>`lower(upload.uploaded_by)`.as("key"),
          sql<string>`min(upload.uploaded_by)`.as("name"),
          sql<string>`count(*)`.as("friends"),
        ])
        .where("upload.kind", "=", "social")
        .where("upload.uploaded_by", "is not", null)
        .groupBy(sql`lower(upload.uploaded_by)`)
        .execute(),
      db
        .selectFrom("comparison_result")
        .select([
          sql<string>`lower(comparison_result.upload_name)`.as("key"),
          sql<string>`count(distinct comparison_result.friend_name)`.as("matched"),
        ])
        .where("comparison_result.upload_name", "is not", null)
        .where(matched())
        .groupBy(sql`lower(comparison_result.upload_name)`)
        .execute(),
    ]);

    const matchedByKey = new Map(
      (matchedRows as any[]).map((r) => [r.key as string, Number(r.matched) || 0])
    );

    return (friendRows as any[])
      .map((r) => {
        const friends = Number(r.friends) || 0;
        const matchedCount = matchedByKey.get(r.key as string) ?? 0;
        return {
          uploader: r.name as string,
          friends,
          matched: matchedCount,
          noMatch: Math.max(0, friends - matchedCount),
        };
      })
      // Strongest first, then alphabetical — the roster picker's own tie-break, made visible.
      .sort((a, b) => b.matched - a.matched || a.uploader.localeCompare(b.uploader));
  }

  /**
   * One uploader's roster, split into the people that matched (grouped by company) and the names
   * that didn't.
   *
   * `matchedByCompany` is one section per company the roster reaches, each listing the friends who
   * landed there — with the matched contact's English and Thai names alongside the uploaded name,
   * because a friend list carries one name each and the contact side is where an English spelling
   * lives. A friend at several companies appears under each. `noMatchNames` is the rest of the
   * roster: friends with no connection on file, the actionable half ("who still needs an intro").
   *
   * The counts mirror `uploaderStats`/`overview` (friends = roster, matched = distinct matched,
   * `noMatch = friends − matched`) so the detail page reconciles with the tab that linked to it.
   * `matched` counts distinct friends regardless of whether the match named a company, so it can
   * exceed the people shown in `matchedByCompany` (which needs a company to group under) — the same
   * "a connection is a company match" stance the Overview takes.
   */
  static async uploaderDetail(name: string): Promise<UploaderDetailData> {
    const db = await this.getKyselyDB();
    const key = name.toLowerCase();

    const [rosterRows, matchedRows] = await Promise.all([
      // The roster: distinct friend names this uploader contributed, one display spelling each.
      db
        .selectFrom("friend")
        .innerJoin("upload", "upload.id", "friend.upload_id")
        .select([
          sql<string>`lower(friend.friend_name)`.as("key"),
          sql<string>`min(friend.friend_name)`.as("name"),
        ])
        .where("upload.kind", "=", "social")
        .where(sql`lower(upload.uploaded_by)`, "=", key)
        .where("friend.friend_name", "is not", null)
        .groupBy(sql`lower(friend.friend_name)`)
        .orderBy(sql`min(friend.friend_name) asc`)
        .execute(),
      // The matched pairs of this uploader, one row per (company, friend), carrying the matched
      // contact's English and Thai names. Grouped case-folded on both sides; `min` keeps one
      // display spelling. `company` is null-selected here but the rows are read below.
      db
        .selectFrom("comparison_result")
        .select([
          sql<string>`lower(comparison_result.friend_name)`.as("friendKey"),
          sql<string | null>`min(comparison_result.company_name)`.as("company"),
          sql<string>`min(comparison_result.friend_name)`.as("friend"),
          sql<string | null>`min(comparison_result.person_name_en)`.as("en"),
          sql<string | null>`min(comparison_result.person_name_th)`.as("th"),
        ])
        .where(sql`lower(comparison_result.upload_name)`, "=", key)
        .where("comparison_result.friend_name", "is not", null)
        .where(matched())
        .groupBy([sql`lower(comparison_result.company_name)`, sql`lower(comparison_result.friend_name)`])
        .orderBy(sql`min(comparison_result.company_name) asc`)
        .orderBy(sql`min(comparison_result.friend_name) asc`)
        .execute(),
    ]);

    // Distinct matched friends — the count, regardless of whether the match named a company.
    const matchedFriendKeys = new Set((matchedRows as any[]).map((r) => r.friendKey as string));

    // Group the company-bearing matches into one section per company, preserving row order (already
    // company-then-friend sorted). Matches with no company are counted but have nowhere to group.
    const groups = new Map<string, { company: string; people: { friend: string; en: string | null; th: string | null }[] }>();
    for (const r of matchedRows as any[]) {
      const company = r.company as string | null;
      if (!company) continue;
      const gkey = company.toLowerCase();
      let g = groups.get(gkey);
      if (!g) {
        g = { company, people: [] };
        groups.set(gkey, g);
      }
      g.people.push({ friend: r.friend as string, en: (r.en as string | null) ?? null, th: (r.th as string | null) ?? null });
    }
    // Strongest first, then alphabetical — the Overview's own ordering for reached companies.
    const matchedByCompany = [...groups.values()].sort(
      (a, b) => b.people.length - a.people.length || a.company.localeCompare(b.company)
    );

    // The roster minus whoever matched (any company) — the friends still without a connection.
    const noMatchNames = (rosterRows as any[])
      .filter((r) => !matchedFriendKeys.has(r.key as string))
      .map((r) => r.name as string);

    const friends = (rosterRows as any[]).length;
    const matchedCount = matchedFriendKeys.size;
    return {
      uploader: name,
      friends,
      matched: matchedCount,
      noMatch: Math.max(0, friends - matchedCount),
      matchedByCompany,
      noMatchNames,
    };
  }

  /**
   * One roster's size and its connections, by friend and by company.
   *
   * `friends` is how many friends the roster uploaded — counted from the friend list itself, so it
   * answers "how many friends did this user upload" even before a comparison exists.
   * `friendsMatched` is how many of those friends matched someone at any company (distinct name);
   * the caller derives "no match" as `friends − friendsMatched`. `connected` is one row per company
   * the roster reaches ("companies known"). `uploader === null` means "everyone".
   */
  static async overview(
    uploader: string | null
  ): Promise<{ friends: number; friendsMatched: number; connected: CompanyConnection[] }> {
    const db = await this.getKyselyDB();

    // Friends this roster uploaded — from the friend table joined to its upload, not from results.
    let friendsQ: any = db
      .selectFrom("friend")
      .innerJoin("upload", "upload.id", "friend.upload_id")
      .select(sql<string>`count(*)`.as("friends"));
    if (uploader) friendsQ = friendsQ.where(sql`lower(upload.uploaded_by)`, "=", uploader.toLowerCase());

    // The matched results for this roster. Filter applied before select/groupBy.
    const scopedResults = (): any => {
      const base = db.selectFrom("comparison_result");
      return uploader
        ? base.where(sql`lower(comparison_result.upload_name)`, "=", uploader.toLowerCase())
        : base;
    };

    const [friendsRow, matchedRow, connectedRows] = await Promise.all([
      friendsQ.executeTakeFirst(),
      // Distinct friends that matched anywhere — the "matched names" count.
      scopedResults()
        .select(sql<string>`count(distinct comparison_result.friend_name)`.as("matched"))
        .where(matched())
        .executeTakeFirst(),
      scopedResults()
        .select([
          sql<string>`min(comparison_result.company_name)`.as("company"),
          sql<string>`count(distinct comparison_result.friend_name)`.as("connections"),
        ])
        .where(matched())
        .where("comparison_result.company_name", "is not", null)
        .groupBy(sql`lower(comparison_result.company_name)`)
        .orderBy(sql`count(distinct comparison_result.friend_name) desc`)
        .orderBy(sql`min(comparison_result.company_name) asc`)
        .execute(),
    ]);

    return {
      friends: Number((friendsRow as any)?.friends) || 0,
      friendsMatched: Number((matchedRow as any)?.matched) || 0,
      connected: (connectedRows as any[]).map((r) => ({
        company: r.company as string,
        connections: Number(r.connections) || 0,
      })),
    };
  }

  /**
   * Company people, each carrying three facts about the network: how many distinct people reach
   * their whole company, which uploaders know THIS contact, and which uploaders reach the COMPANY
   * (anyone there). All are correlated subqueries — cheap, because they run over the page's rows
   * only, and indexed (see the comparison_result name/company indexes). Company-wide reach is
   * network-wide (not scoped to one uploader): "who can get to this company", not "which roster".
   *
   * Two ways to select the rows:
   *   · `q`       — free-text ILIKE across the person names and the company.
   *   · `company` — an EXACT (case-insensitive) company name, for the Overview's company popup.
   * Exactly one is expected; `company` wins if both are somehow present.
   */
  static async search(
    params: { q?: string; company?: string },
    page: number,
    limit: number
  ): Promise<PaginatedResult<NameSearchRow>> {
    const db = await this.getKyselyDB();
    const offset = (page - 1) * limit;

    // The row selector, as one WHERE so it AND-combines cleanly and the count agrees with the page.
    const constrain = (q: any): any => {
      if (params.company) {
        return q.where(sql`lower(company_contact.company_name)`, "=", params.company.toLowerCase());
      }
      const like = `%${escapeLike(params.q ?? "")}%`;
      return q.where((eb: any) =>
        eb.or([
          eb("company_contact.person_name_en", "ilike", like),
          eb("company_contact.person_name_th", "ilike", like),
          eb("company_contact.company_name", "ilike", like),
        ])
      );
    };

    const rowsQuery = constrain(
      db
        .selectFrom("company_contact")
        .select([
          "company_contact.id as id",
          "company_contact.company_name",
          "company_contact.person_name_en",
          "company_contact.person_name_th",
        ])
        .select([
          sql<string>`(
            select count(distinct cr.friend_name)
            from comparison_result cr
            where cr.company_name is not null
              and lower(cr.company_name) = lower(company_contact.company_name)
              and ${matchedFor("cr.status")}
          )`.as("companyConnections"),
          sql<string[]>`array(
            select distinct cr.upload_name
            from comparison_result cr
            where cr.upload_name is not null
              and ${matchedFor("cr.status")}
              and (
                cr.person_name_en = company_contact.person_name_en
                or cr.person_name_th = company_contact.person_name_th
              )
            order by cr.upload_name
          )`.as("connectedUploaders"),
          sql<string[]>`array(
            select distinct cr.upload_name
            from comparison_result cr
            where cr.upload_name is not null
              and cr.company_name is not null
              and lower(cr.company_name) = lower(company_contact.company_name)
              and ${matchedFor("cr.status")}
            order by cr.upload_name
          )`.as("companyUploaders"),
        ])
    )
      .orderBy("company_contact.company_name", "asc")
      .orderBy("company_contact.id", "asc")
      .limit(limit)
      .offset(offset);

    const [rows, countRow] = await Promise.all([
      rowsQuery.execute(),
      constrain(db.selectFrom("company_contact").select(db.fn.countAll().as("count"))).executeTakeFirst(),
    ]);

    const arr = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : []);
    const total = Number((countRow as any)?.count) || 0;
    return {
      data: (rows as any[]).map((r) => ({
        id: String(r.id),
        company_name: r.company_name ?? null,
        person_name_en: r.person_name_en ?? null,
        person_name_th: r.person_name_th ?? null,
        companyConnections: Number(r.companyConnections) || 0,
        // node-postgres hands a text[] back as a JS array of strings.
        connectedUploaders: arr(r.connectedUploaders),
        companyUploaders: arr(r.companyUploaders),
      })),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }
}
