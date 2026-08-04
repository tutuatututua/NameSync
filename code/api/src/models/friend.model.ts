import { DBModel } from "@extensions/sqldb";
import { sql, type RawBuilder, type SqlBool } from "kysely";
import {
  compareByAxes,
  type CompareBy,
  type CompareLanguage,
  type PaginatedResult,
  type FacebookDataRow,
  type RunRow,
} from "@extensions/contract";
import { isExternalMatcher } from "../config/env";
import { sameFriendSql } from "./friend-identity";
import {
  effectiveStatusSql,
  isMatchedSql,
  matchedFirstSql,
  regradeVerdictSql,
  regradedStatusSql,
  rowVerdictWithMatchSql,
  runRowBucketSql,
  tallyVerdicts,
  type StatusCounts,
} from "./row-status";
import { rowFilterWhere, toRunRow, type RawRunRow, type RunRowFilter, type RunRowSort } from "./run-rows";

/**
 * "This friend has a match in the run" — an EXISTS over its matched `comparison_result` pairs.
 *
 * The verdict a workflow reaches lives in two places that need not agree: it stamps `friend.status`,
 * and it writes the pair here. When a workflow records the match *only* as a pair — stamping the
 * source row with a bare done-marker like `complete` — this is what still lets the row read as
 * matched. Identity comes from `sameFriendSql` — `friend_id` where the writer supplied it, either
 * spelling otherwise — and is scoped to the run, since a friend may have been scored by several.
 * Correlated to the `friend` row, so it only makes sense inside a query rooted at `friend`.
 */
const friendHasMatch = (comparisonId: string): RawBuilder<SqlBool> => sql<SqlBool>`exists (
  select 1 from comparison_result as cr
  where cr.comparison_id = ${comparisonId}
    and ${sameFriendSql("cr", "friend")}
    and ${isMatchedSql("cr.status")}
)`;

/**
 * The score of the pair this row is SHOWING — for re-grading the row at a bar the reader picked.
 *
 * A correlated scalar subquery rather than a reuse of the `best` lateral in `findRunRows`, because
 * the two places that need it cannot see that lateral: the filter's WHERE and the tally's GROUP BY
 * both run over `friend` alone, before any join has happened.
 *
 * ITS ORDER BY IS A COPY OF THE LATERAL'S, DELIBERATELY, AND MUST STAY ONE. A friend who matched
 * several contacts has several scores, and the row displays exactly one of them — the lateral's
 * pick. If this subquery picked a different pair (the plain `max`, say), a row could be re-graded
 * `matched` on a 0.91 while the number printed beside the badge read 0.62. The badge and the score
 * on one line have to come from the same pair. See FriendModel.findRunRows for what each clause of
 * the ordering is for.
 *
 * Null where the run recorded no score — an external workflow reporting verdicts alone, or a row it
 * never wrote a pair for. `regradeVerdictSql` passes those through to their stored verdict rather
 * than inventing one.
 */
const friendBestSimilarity = (comparisonId: string): RawBuilder<number | null> => sql<number | null>`(
  select cr.similarity from comparison_result as cr
  where cr.comparison_id = ${comparisonId}
    and ${sameFriendSql("cr", "friend")}
  order by ${matchedFirstSql("cr.status")},
           case when lower(cr.upload_name) = lower(friend.relationship_owner) then 0 else 1 end,
           cr.similarity desc nulls last,
           cr.id asc
  limit 1
)`;

/**
 * `friend` — social contacts, stacked upload by upload. Every row is tagged with its
 * `upload_id`, so undoing an upload is just "delete this upload's rows". Read methods
 * alias columns back to the legacy FacebookDataRow shape (uuid/fb_name/…).
 *
 * `friend_name_en` / `friend_name_th` hold the name already cleaned and lower-cased — see
 * services/name-cleaner.service.ts, which is applied at parse time. Stored once each: there
 * is no raw twin, and the file's own spelling survives only in the import preview. That is
 * what makes these columns safe to compare, join and group on directly, without every reader
 * lower-casing defensively at its own end.
 *
 * TWO COLUMNS SINCE 2026-07-28, symmetric with `company_contact`. The single `friend_name` they
 * replaced is still on the table for one migration's worth of rollback and is read by nothing.
 * At least one is non-null on every stored row — "no usable name at all" is the only thing the
 * import gate drops on, and it must never become "no name in the run's language".
 *
 * `relationship_owner` holds whose relationship this is, PER ROW, and is the column the whole
 * product points at: it is the name someone is told to go and ask. Cleaned but case-preserving
 * (`cleanOwnerName`), because unlike `friend_name` it is never matched — only grouped, which
 * every reader does case-insensitively at its own end, and then displayed.
 *
 * DEDUP KEY is (owner, EITHER spelling), folded on the owner.
 *
 * It was (upload.uploaded_by, name) — the owner reached through the parent upload — until
 * 2026-07-27, which could only describe a file as having ONE owner. A friends export can
 * hold several people's contacts, and under the old key two owners in one file deduped
 * against each other and merged two rosters into one.
 *
 * The owner half is folded. The name half always was; the owner half matched exactly, while
 * every roster query in the Network workspace grouped it with `lower(...)` — so "Alex" and
 * "alex" were two rosters to the dedup and one roster to the Overview.
 *
 * ── Why "either spelling" and not "both" ──
 *
 * With two name columns, a strict key over the pair would file one person as two roster entries:
 * they arrive English-only from a Facebook export and bilingual from a business card, and those
 * are different tuples. That is a visible regression — the roster grows and every count with it.
 *
 * So a row matching an existing one on the same owner and EITHER non-null spelling IS that friend,
 * and fills in the spelling it was missing. `mergeUpload` is an upsert rather than a drop.
 *
 * ── The conflict rule: fill NULLs only, never overwrite ──
 *
 * An import may FILL a null spelling. It may never CHANGE one that is already there.
 *
 * The reason is not tidiness. Result rows written without `friend_id` — every external-workflow
 * row, and everything predating that column — are resolved back to their friend BY NAME, so
 * overwriting a spelling orphans them and the counts break retroactively and silently. `friend_id`
 * narrows that exposure without closing it, because we do not control who writes that table. It is
 * also the stance the whole codebase takes: imports append, verdicts are permanent, history is
 * frozen. A conflicting value is counted and reported, not applied — the Database console stays
 * the deliberate, visible way to change a stored name.
 *
 * The consequence worth stating, because it looks like a regression and is the point: the same
 * person under a DIFFERENT owner is a second row, not a duplicate. That was already true when
 * two people each imported them; it is now true within one file. One person known by three
 * colleagues is three rows, three rosters and three ways to reach them, which is the product.
 */

export interface FriendRecord {
  /**
   * The friend's two spellings, already cleaned and lower-cased by the parser.
   *
   * BOTH null means the row has no usable name and the import gate drops it. Exactly one null is
   * the normal case (a Facebook export gives one name) and is stored as-is — a later import may
   * fill the other. What must never happen is dropping a row because the RUN's language column is
   * the null one: the mode decides what is scored, not what is stored.
   */
  friend_name_en: string | null;
  friend_name_th: string | null;
  /**
   * Whose relationship this is, as the FILE gave it — cleaned, case preserved.
   *
   * Null when the file has no owner column at all, and also when it has one but this row left
   * it blank. Both are the same situation to the import: a typed owner covers them, and without
   * one the import is refused rather than stored unowned (see `prepareFriends` in
   * comparisons.route.ts). The preview counts them the same way (`ownerlessRows`) so the screen
   * can ask for a name exactly when the import would insist on it.
   *
   * What reaches the database is never this value when an owner was typed: the typed name
   * overrides the file's on every row.
   */
  relationship_owner: string | null;
}

/** The two languages, as the columns they name. Iterated wherever both must be handled alike. */
const LANGS = ["en", "th"] as const;
const NAME_COL = { en: "friend_name_en", th: "friend_name_th" } as const;
const otherLanguage = (l: CompareLanguage): CompareLanguage => (l === "th" ? "en" : "th");

/**
 * "Could this row have been scored at all?" — a FACT about the data now, not an inference.
 *
 * It used to script-test the one stored name to GUESS whether the run could have looked at this
 * friend, and carried a caveat that for an external run this was OUR READING of the text rather
 * than a report of what the workflow did. With a column per language on both sides the test is the
 * same one the contact side has always used: is the column the run selected non-null.
 *
 * That makes the "Not compared" bucket honest rather than merely plausible — the row is excluded
 * because we hold no name in that language, which is checkable, instead of because its characters
 * looked like the wrong script.
 */
const scorableSql = (language: CompareLanguage): RawBuilder<SqlBool> =>
  sql<SqlBool>`${sql.ref(`friend.${NAME_COL[language]}`)} is not null`;

/**
 * One (owner, language, name) lookup key.
 *
 * JSON keeps a missing value distinct from the literal string "null" and keeps the parts from
 * running together ("ab"+"c" vs "a"+"bc"). The language is IN the key so an English "somchai" and
 * a Thai column holding the same characters cannot collide — they would be different people.
 *
 * Both halves lower-cased: the parser already writes names lower-cased so that is a no-op on the
 * normal path, but the Database console writes these columns directly, bypassing the cleaner, and
 * a hand-typed "Somchai Jaidee" that did not fold here would never dedupe against an imported
 * "somchai jaidee".
 */
const spellKey = (owner: string | null, lang: CompareLanguage, name: string) =>
  JSON.stringify([owner === null ? null : owner.toLowerCase(), lang, name.toLowerCase()]);

/**
 * One enriched row as the merge FOUND it, which is what it takes to put it back.
 *
 * `en` / `th` are the spellings this merge FILLED, not the row's previous contents — the fill-only
 * rule (see the conflict rule above) means anything it wrote was NULL beforehand, so "what it wrote"
 * and "what to undo" are the same list. Null in a language the merge did not touch.
 *
 * `status` is the verdict the row carried before the merge reset it to 'processing'. Null when the
 * column was not read (internal matcher), in which case reverting leaves it alone rather than
 * writing a null into a NOT NULL column.
 */
export interface EnrichedBefore {
  id: string;
  en: string | null;
  th: string | null;
  status: string | null;
}

/** What one merge did. `added + enriched` is the number of rows with something new to match. */
export interface MergeResult {
  added: number;
  duplicates: number;
  /** Existing friends that gained a spelling they did not have. */
  enriched: number;
  /**
   * The ids of those rows, so the caller can send them to the workflow.
   *
   * They are NOT in this upload — an enriched row belongs to whichever import first created it —
   * so `findByUploadId` cannot see them and the webhook payload has to be told about them
   * explicitly. They carry matchable data no previous run has ever seen, which is exactly the
   * definition of a row worth matching.
   */
  enrichedIds: string[];
  /**
   * The same rows, described well enough to undo — for an import whose handover to the ingestion
   * webhook fails and is therefore discarded whole (see `revertEnrichment`).
   *
   * Deleting the upload's own rows cannot reach these: an enriched friend belongs to an EARLIER
   * import, so a cascade from this one leaves it holding a spelling that no successful import ever
   * put there, and stuck at 'processing'.
   */
  enrichedBefore: EnrichedBefore[];
  /**
   * Incoming spellings that DISAGREED with a stored one. Counted and reported, never applied —
   * see the conflict rule in this file's header for why overwriting is the unsafe direction.
   */
  conflicts: number;
}

// friend rows aliased to the legacy FacebookDataRow shape.
//
// `upload_person_name` carries the RELATIONSHIP OWNER, which is what it has always carried —
// it used to alias `upload.uploaded_by` back when that column meant "the owner for this
// import". Pointing it at `uploaded_by` after the split would have silently changed its
// meaning to "the uploader", and this value travels to the external workflow, which writes it
// into `comparison_result.upload_name` — the column every roster in the Network workspace is
// grouped by. Rosters would have started grouping by uploader, with nothing anywhere erroring.
//
// `status` is only read when the external matcher is on. The column arrives with the
// row-status migration, which is applied by hand against a live database — so until someone
// runs it, the column does not exist, and a SELECT that named it would break every read on
// this table. With the flag off the app never mentions it and works either way.
//
// `fb_name` survives the move to two columns and is NOT dropped, because the external workflow
// parses this CSV positionally. It is the one name a single-spelling friend has, and the English
// one when both exist — which is exactly what it held before, for every row that existed before.
// The two real columns are APPENDED after everything else, never interleaved, so a positional
// parser that has never heard of them keeps working (docs/EXTERNAL-MATCHER.md). Drop `fb_name`
// once the workflow picks its column by `compare_language` on its own schedule.
const friendRowSelect = [
  "friend.id as uuid",
  sql<string | null>`coalesce(friend.friend_name_en, friend.friend_name_th)`.as("fb_name"),
  "friend.relationship_owner as upload_person_name",
  isExternalMatcher()
    ? sql<string | null>`friend.status`.as("status")
    : sql<string | null>`null`.as("status"),
  "friend.upload_id as session_id",
  "friend.friend_name_en as friend_name_en",
  "friend.friend_name_th as friend_name_th",
] as const;

export class FriendModel extends DBModel {
  /**
   * Insert an upload's parsed friends, skipping any (owner, name) pair that owner already has
   * — from an earlier upload, or twice within this file.
   *
   * `records` arrive with their owners already resolved: the route has applied the typed owner
   * over every row when one was given, and refused the import outright if that left any row
   * unowned — so every record here knows whose it is and this method never has to look at the
   * parent upload. That is the structural change: the owner used to be read once, from
   * `upload.uploaded_by`, and applied to the whole batch.
   */
  static async mergeUpload(
    uploadId: string,
    source: string,
    records: FriendRecord[]
  ): Promise<MergeResult> {
    const empty: MergeResult = {
      added: 0,
      duplicates: 0,
      enriched: 0,
      enrichedIds: [],
      enrichedBefore: [],
      conflicts: 0,
    };
    if (records.length === 0) return empty;
    const db = await this.getKyselyDB();

    // Only the owners this batch actually mentions can collide, so the prior scan is scoped to
    // them rather than reading the whole table — one query however many owners the file names,
    // not one per owner. Folded, because the key is folded.
    const owners = [...new Set(records.map((r) => r.relationship_owner))];
    const named = [...new Set(owners.filter((o): o is string => o !== null).map((o) => o.toLowerCase()))];
    // A record with no owner only ever dedupes against other ownerless rows — the same stance
    // the old key took for an upload with no uploader. Unreachable from the import (a social
    // import is refused without an owner), but the DB console can write one.
    const hasUnowned = owners.includes(null);

    const prior = await db
      .selectFrom("friend")
      .select([
        "friend.id",
        "friend.relationship_owner",
        "friend.friend_name_en",
        "friend.friend_name_th",
        // The verdict an enriched row is about to lose — the UPDATE below resets it to
        // 'processing' — kept so a discarded import can put it back. Read here rather than
        // re-queried later because "before" only exists before.
        //
        // Guarded like every other read of this column: it arrives with the hand-applied
        // row-status migration (see friendRowSelect), and this SELECT runs on every social
        // import, so naming it unconditionally would break them all on a database that has not
        // had that migration. Null then, which `revertEnrichment` reads as "leave it alone".
        (isExternalMatcher()
          ? sql<string | null>`friend.status`
          : sql<string | null>`null`
        ).as("prior_status"),
      ])
      .where((eb) =>
        eb.or([
          ...(named.length > 0 ? [eb(sql<string>`lower(friend.relationship_owner)`, "in", named)] : []),
          ...(hasUnowned ? [eb("friend.relationship_owner", "is", null)] : []),
        ])
      )
      .execute();

    /**
     * One person, as this merge currently understands them.
     *
     * `id` is null for a friend this batch is about to INSERT. Such a row needs no UPDATE: filling
     * its missing spelling is an edit to the pending record, which then gets inserted complete.
     * That is what makes a single file carrying "somchai jaidee" on one line and "somchai jaidee /
     * สมชาย ใจดี" on another produce ONE row with both spellings rather than a row plus an update.
     */
    type Slot = {
      id: string | null;
      owner: string | null;
      en: string | null;
      th: string | null;
      pending: FriendRecord | null;
    };

    // Every stored spelling is a way in to its row, which is what "either spelling identifies the
    // friend" means operationally: two keys per row, both pointing at the same Slot.
    const index = new Map<string, Slot>();
    const put = (slot: Slot, lang: CompareLanguage, name: string | null) => {
      if (name) index.set(spellKey(slot.owner, lang, name), slot);
    };
    // Kept beside the index rather than on the Slot: it is not part of identity, and only the
    // rows that turn out to be enriched will ever be asked for it.
    const priorStatus = new Map<string, string | null>();

    for (const r of prior) {
      const slot: Slot = {
        id: r.id as string,
        owner: r.relationship_owner,
        en: r.friend_name_en,
        th: r.friend_name_th,
        pending: null,
      };
      priorStatus.set(slot.id as string, r.prior_status ?? null);
      put(slot, "en", slot.en);
      put(slot, "th", slot.th);
    }

    // Both sides of the comparison are keyed the same way, which is the only reason it is
    // correct: stored names and incoming names have been through the same cleaner, so the
    // strings are directly comparable and neither side needs a fallback the other lacks.
    const find = (r: FriendRecord): Slot | null => {
      for (const lang of LANGS) {
        const name = r[NAME_COL[lang]];
        if (!name) continue;
        const hit = index.get(spellKey(r.relationship_owner, lang, name));
        if (hit) return hit;
      }
      return null;
    };

    const fresh: FriendRecord[] = [];
    const updates: { id: string; en: string | null; th: string | null }[] = [];
    const enrichedIds = new Set<string>();
    let duplicates = 0;
    let conflicts = 0;

    for (const r of records) {
      const hit = find(r);

      if (!hit) {
        const slot: Slot = {
          id: null,
          owner: r.relationship_owner,
          en: r.friend_name_en,
          th: r.friend_name_th,
          pending: r,
        };
        put(slot, "en", slot.en);
        put(slot, "th", slot.th);
        fresh.push(r);
        continue;
      }

      // Fill what is missing, refuse what disagrees, and count both. A record can do both at once
      // (its English name matches but differs in case-folded spelling while its Thai name is new),
      // so these are not exclusive and neither short-circuits the other.
      const patch: { en: string | null; th: string | null } = { en: null, th: null };
      let filled = false;
      let conflicted = false;

      for (const lang of LANGS) {
        const incoming = r[NAME_COL[lang]];
        if (!incoming) continue;
        const stored = hit[lang];
        if (stored === null) {
          patch[lang] = incoming;
          filled = true;
        } else if (stored !== incoming) {
          conflicted = true;
        }
      }

      if (conflicted) conflicts += 1;

      if (filled) {
        for (const lang of LANGS) {
          const value = patch[lang];
          if (!value) continue;
          hit[lang] = value;
          // Register the new spelling so a LATER record in this same batch that carries only that
          // spelling still resolves to this friend instead of inserting a second row.
          put(hit, lang, value);
        }
        if (hit.pending) {
          // Not yet in the database: fill the record that is about to be inserted.
          hit.pending.friend_name_en = hit.en;
          hit.pending.friend_name_th = hit.th;
        } else if (hit.id) {
          updates.push({ id: hit.id, en: patch.en, th: patch.th });
          enrichedIds.add(hit.id);
        }
      } else if (!conflicted) {
        duplicates += 1;
      }
    }

    if (fresh.length > 0) {
      await db
        .insertInto("friend")
        .values(
          fresh.map((r) => ({
            upload_id: uploadId,
            source,
            friend_name_en: r.friend_name_en,
            friend_name_th: r.friend_name_th,
            relationship_owner: r.relationship_owner,
          }))
        )
        .execute();
    }

    if (updates.length > 0) {
      /**
       * One statement, not one per row: a first bilingual import can enrich thousands of existing
       * friends, and a loop of UPDATEs would make that import's cost linear in round trips.
       *
       * `coalesce(f.<col>, v.<col>)` enforces fill-only IN THE DATABASE as well as in the loop
       * above. That is not redundancy for its own sake — it means a spelling written between the
       * SELECT and this UPDATE cannot be clobbered by a decision made against a stale read.
       *
       * `status` resets to 'processing' because the row now holds data no run has matched against.
       * That is what makes the completion poll wait for these rows rather than reporting the
       * import finished before the workflow has seen them. `updated_at` moves on its own —
       * `trg_friend_updated` fires on every UPDATE — and it should: the row did change.
       */
      const values = sql.join(
        updates.map(
          (u) =>
            sql`(${sql.val(u.id)}::bigint, ${sql.val(u.en)}::varchar, ${sql.val(u.th)}::varchar)`
        )
      );
      await sql`
        update friend as f
           set friend_name_en = coalesce(f.friend_name_en, v.en),
               friend_name_th = coalesce(f.friend_name_th, v.th),
               status = ${sql.val("processing")}
          from (values ${values}) as v(id, en, th)
         where f.id = v.id
      `.execute(db);
    }

    /**
     * The undo list, folded to one entry per row.
     *
     * `updates` is per RECORD and `enrichedIds` is per ROW, and the two can differ: nothing stops
     * two lines of one file filling one friend's two missing spellings separately. Reverting from
     * the unfolded list would then emit two VALUES rows for the same id, and `update … from
     * (values …)` applies exactly one of them — an arbitrary one — silently leaving the other
     * spelling behind. Folded here so there is one row per id by construction.
     */
    const before = new Map<string, EnrichedBefore>();
    for (const u of updates) {
      const seen = before.get(u.id);
      if (seen) {
        seen.en = seen.en ?? u.en;
        seen.th = seen.th ?? u.th;
      } else {
        before.set(u.id, { id: u.id, en: u.en, th: u.th, status: priorStatus.get(u.id) ?? null });
      }
    }

    return {
      added: fresh.length,
      duplicates,
      enriched: enrichedIds.size,
      enrichedIds: [...enrichedIds],
      enrichedBefore: [...before.values()],
      conflicts,
    };
  }

  /**
   * Put enriched rows back the way `mergeUpload` found them.
   *
   * The other half of discarding an import whose rows never reached the ingestion webhook.
   * Deleting the upload takes its own rows with it (`upload_id … ON DELETE CASCADE`); these rows
   * belong to earlier imports and would otherwise keep a spelling that no successful import ever
   * put there, which is precisely the "saved anyway" this exists to prevent.
   *
   * Two rules, both load-bearing:
   *
   *   · A spelling is cleared only where the column STILL HOLDS THE VALUE WE WROTE. The enrich
   *     UPDATE fills through `coalesce`, so a concurrent writer may have got there first and our
   *     write was a no-op; nulling their value would make this method cause the data loss it
   *     exists to prevent.
   *   · `status` is restored through `coalesce(v.status, f.status)`, so a merge that never read
   *     the column (internal matcher) leaves it untouched instead of writing a null into a NOT
   *     NULL column. Restoring it matters: a row left at 'processing' holds the EARLIER import's
   *     run open forever, since completion is decided by asking whether any row is unfinished.
   *
   * One statement, for the same reason the enrich UPDATE is one: a first bilingual import can
   * enrich thousands of rows, and undoing it must not cost thousands of round trips.
   */
  static async revertEnrichment(before: EnrichedBefore[]): Promise<void> {
    if (before.length === 0) return;
    const db = await this.getKyselyDB();
    const values = sql.join(
      before.map(
        (b) =>
          sql`(${sql.val(b.id)}::bigint, ${sql.val(b.en)}::varchar, ${sql.val(b.th)}::varchar, ${sql.val(b.status)}::text)`
      )
    );
    await sql`
      update friend as f
         set friend_name_en = case when v.en is not null and f.friend_name_en = v.en
                                   then null else f.friend_name_en end,
             friend_name_th = case when v.th is not null and f.friend_name_th = v.th
                                   then null else f.friend_name_th end,
             status = coalesce(v.status, f.status)
        from (values ${values}) as v(id, en, th, status)
       where f.id = v.id
    `.execute(db);
  }

  /** The stored rows for a set of ids — the enriched friends, for the webhook payload. */
  static async findByIds(ids: string[]): Promise<FacebookDataRow[]> {
    if (ids.length === 0) return [];
    const db = await this.getKyselyDB();
    const rows = await db
      .selectFrom("friend")
      .leftJoin("upload", "upload.id", "friend.upload_id")
      .select(friendRowSelect as never)
      .where("friend.id", "in", ids)
      .orderBy("friend.id", "asc")
      .execute();
    return rows as unknown as FacebookDataRow[];
  }

  /** Total rows. */
  static async stats(): Promise<{ total: number }> {
    const db = await this.getKyselyDB();
    const row = await db.selectFrom("friend").select(db.fn.count("id").as("count")).executeTakeFirst();
    return { total: Number(row?.count) || 0 };
  }

  /**
   * How far the external workflow has got through one upload's rows.
   *
   * This is the whole progress mechanism: there is no callback and no event, so "is the
   * import finished?" is answered by counting the rows it has not stamped yet. Only ever
   * called with EXTERNAL_MATCHER on — it names a column that may not exist otherwise.
   */
  static async statusCounts(
    uploadId: string,
    comparisonId: string,
    compareBy: CompareBy,
    /** The reader's chosen bar, or null for the workflow's own verdicts. Rows this run recorded no
     *  score for keep theirs — see `regradeVerdict`, and note that a workflow reporting verdicts
     *  alone therefore moves not at all, which is why the control is hidden for one. */
    threshold: number | null = null
  ): Promise<StatusCounts> {
    const db = await this.getKyselyDB();
    const { language } = compareByAxes(compareBy);
    const scorable = scorableSql(language);

    // Derived first, grouped second — see ComparisonResultModel.statusCounts for why a
    // `group by case…end` that mirrors the select does not survive contact with Postgres.
    const rows = await db
      .selectFrom((eb) =>
        eb
          .selectFrom("friend")
          .select(
            runRowBucketSql(
              regradeVerdictSql(
                rowVerdictWithMatchSql("friend.status", friendHasMatch(comparisonId)),
                friendBestSimilarity(comparisonId),
                threshold
              ),
              scorable
            ).as("verdict")
          )
          .where("friend.upload_id", "=", uploadId)
          .as("verdicts")
      )
      .select((eb) => ["verdicts.verdict", eb.fn.countAll().as("count")])
      .groupBy("verdicts.verdict")
      .execute();

    return tallyVerdicts(rows as { verdict: string; count: unknown }[]);
  }

  /**
   * One page of an import's rows, each with whatever the workflow has said about it so far.
   *
   * This is the live monitor's feed. `statusCounts` above says *how many* rows are done; this
   * says *which*, which is the question someone watching their own import is actually asking.
   *
   * The match is joined **on the name**, because `comparison_result` has no foreign key back to
   * the row it came from — the workflow is handed a CSV and writes pairs of names, so a name is
   * all there is to join on. Consequences, both deliberate:
   *   · a row the workflow renamed (cleaned differently, transliterated) finds no result and
   *     shows none, rather than picking up a stranger's;
   *   · two friends with the identical name, under different owners, are both candidates for the
   *     same result row. They are the same string to the matcher, so it genuinely did say the
   *     same thing twice — but each row now prefers the result whose `upload_name` names ITS
   *     owner (see the ORDER BY), which matters much more since the dedup key became (owner,
   *     name): one person known by three colleagues is three rows here, not one.
   * LATERAL … LIMIT 1 rather than a plain join so a row that matched several contacts stays one
   * row instead of silently multiplying into several. Which one it keeps is now `matchedFirstSql`
   * plus row order — see there for why that is coarser than the score-ranking it replaced.
   *
   * A second lateral reaches past the result to the contact themself, for the one fact the result
   * row does not carry: the company they work for. `comparison_result` stores a pair of names and
   * a verdict and nothing else, so "Somchai Jaidee matched Somchai Prasert" is all it can say — and
   * that is trivia. "…Somchai Prasert *at Acme Co*" is the answer the app exists to give. Joined
   * on either spelling of the contact's name, since a result may carry only one of the two.
   *
   * Only ever called with EXTERNAL_MATCHER on — it names `status`, which may not exist otherwise.
   */
  static async findRunRows(
    uploadId: string,
    comparisonId: string,
    page: number,
    limit: number,
    filter: RunRowFilter,
    sort: RunRowSort,
    compareBy: CompareBy,
    /** The reader's chosen bar, or null for the workflow's own verdicts. See `regradeVerdict`. */
    threshold: number | null = null
  ): Promise<PaginatedResult<RunRow>> {
    const db = await this.getKyselyDB();
    const offset = (page - 1) * limit;
    const { language } = compareByAxes(compareBy);
    // Matched-ness may come from the row's `comparison_result` pair, not its own stamp — so the
    // filter, the returned status and the sort are all derived from the same pair-aware expression,
    // built once here so the three cannot drift.
    const hasMatch = friendHasMatch(comparisonId);
    // The score of the pair this row will DISPLAY, so the badge the threshold produces and the
    // number printed next to it are about the same match. See `friendBestSimilarity`.
    const bestSimilarity = friendBestSimilarity(comparisonId);
    const stored = rowVerdictWithMatchSql("friend.status", hasMatch);
    const verdict = regradeVerdictSql(stored, bestSimilarity, threshold);
    // Never null: the `either` mode that scored both columns, and so excluded nobody, is gone —
    // every run now has friends it did not look at. See `scorableSql`.
    const scorable = scorableSql(language);
    const bucket = runRowBucketSql(verdict, scorable);
    const where = rowFilterWhere(bucket, filter);

    let rows = db.selectFrom("friend").where("friend.upload_id", "=", uploadId);
    if (where) rows = rows.where(where);

    let count = db.selectFrom("friend").where("friend.upload_id", "=", uploadId);
    if (where) count = count.where(where);

    const selected = rows
      .innerJoin("upload", "upload.id", "friend.upload_id")
      .leftJoinLateral(
        (eb) =>
          eb
            .selectFrom("comparison_result")
            .select([
              "comparison_result.person_name_en",
              "comparison_result.person_name_th",
              "comparison_result.company_name",
              "comparison_result.similarity",
              "comparison_result.extra",
            ])
            .where("comparison_result.comparison_id", "=", comparisonId)
            .where(sameFriendSql("comparison_result", "friend"))
            .orderBy(matchedFirstSql("comparison_result.status"))
            // Then the result belonging to THIS row's owner, where the matcher said whose it was.
            //
            // Necessary since the dedup key became (owner, name): one person known by three
            // colleagues is now three friend rows with the same name, and the name-only join
            // above attaches every result to all three. `upload_name` already carries the owner
            // (the matcher fills it from `relationship_owner`), so preferring the matching one
            // gives each row its own result back. A tie-break rather than a WHERE, deliberately:
            // an external workflow is not obliged to send `upload_name`, and a run that omits it
            // must still show its matches rather than none of them.
            .orderBy(
              sql`case when lower(comparison_result.upload_name) = lower(friend.relationship_owner) then 0 else 1 end`
            )
            // Then the closest of them. This is the score-ranking the comment below says was lost:
            // a friend who matched several contacts shows the one they matched *best*, not the one
            // that happened to be inserted first. NULLs last, so a matcher that scores some pairs
            // and not others never lets an unscored row outrank a scored one.
            .orderBy(sql`comparison_result.similarity desc nulls last`)
            .orderBy("comparison_result.id", "asc")
            .limit(1)
            .as("best"),
        (join) => join.onTrue()
      )
      .leftJoinLateral(
        (eb) =>
          eb
            .selectFrom("company_contact")
            .select("company_contact.company_name")
            .where(
              sql<SqlBool>`(
                company_contact.person_name_en = best.person_name_en
                or company_contact.person_name_th = best.person_name_th
              )`
            )
            .limit(1)
            .as("contact"),
        (join) => join.onTrue()
      )
      .select([
        "friend.id as id",
        /**
         * The spelling THIS RUN COMPARED, and beside it the one it did not.
         *
         * The old reasoning here — that a friend has one name, and that a second column would file
         * the same string under a label without recovering information — was sound for a Facebook
         * export and wrong in general. A business card carries both spellings and is a first-class
         * import type (`upload_source`), so the second name was arriving in the files and being
         * dropped by the parser. `friend` is now symmetric with `company_contact`, and neither
         * column is derived from the other: each is what some file actually said.
         *
         * `name` is the run's language FIRST so the span `namePartSpan` marks belongs to the string
         * that was actually scored — falling back to the other spelling, which is not a fallback so
         * much as the rule itself: a row with nothing in the run's column IS an unscored row, and
         * the other spelling is its entire content ("we hold this person, just not in the language
         * this run needed"). So "show what was compared, or else what we have" is one expression
         * rather than a branch the UI has to re-derive, and `name` is never null for a friend who
         * has any name at all.
         *
         * `nameAlt` is the other spelling on its own, for the title of a row that DID score — the
         * uncompared name belongs there rather than on the row, where it would add height to every
         * row for something the run's finding does not depend on.
         */
        sql<string | null>`coalesce(
          ${sql.ref(`friend.${NAME_COL[language]}`)},
          ${sql.ref(`friend.${NAME_COL[otherLanguage(language)]}`)}
        )`.as("name"),
        // A contact column, and a friend is not a contact — see `RunRow.nameTh`.
        sql<string | null>`null`.as("nameTh"),
        sql<string | null>`${sql.ref(`friend.${NAME_COL[otherLanguage(language)]}`)}`.as("nameAlt"),
        // Whose relationship this is — the row's own column now, not the parent upload's. This
        // is the answer the table exists to give, so it is also selected on its own below.
        "friend.relationship_owner as context",
        "friend.relationship_owner as relationshipOwner",
        "upload.uploaded_by as uploaderName",
        sql<string | null>`friend.updated_at`.as("updatedAt"),
        // False renders as "Not compared", never as "No match". A matched row is scored by
        // definition, whatever its script reads like — see runRowBucketSql.
        (scorable
          ? sql<boolean>`(${scorable} or ${isMatchedSql("friend.status")} or ${hasMatch})`
          : sql<boolean>`true`
        ).as("scored"),
        // The workflow's stamp — or, at a bar the reader picked, the stamp that bar implies. The
        // badge is drawn from this string, so it has to describe the same verdict the filter and the
        // tab counts were built from. See regradedStatusSql.
        regradedStatusSql(
          effectiveStatusSql("friend.status", hasMatch),
          bestSimilarity,
          verdict,
          threshold
        ).as("status"),
        "best.person_name_en as matchedName",
        "best.person_name_th as matchedNameTh",
        // How close it was. Carried from the result row, because that is the only place a score
        // for an import exists — `friend` has no such column, and never will: a score is a fact
        // about a *pair*, not about a name. Null on a run whose matcher reported only verdicts,
        // which is what makes the column hideable (see ComparisonResultModel.hasSimilarity).
        "best.similarity as similarity",
        // The result row's own answer first; the by-name lookup only for rows that never recorded
        // one. With several companies in scope the lookup is a guess (two employers can share a
        // name), so it must never overrule a matcher that actually knows — the same precedence
        // company-contact.model.ts uses. Was previously `contact.company_name` alone, which let the
        // guess win even when the stored company_name was right there.
        sql<string | null>`coalesce(best.company_name, contact.company_name)`.as("matchedContext"),
        sql<string | null>`best.extra::text`.as("extras"),
      ]);

    /**
     * Import order, or matches first — and the choice is the caller's because it depends on whether
     * the run is still moving, not on which table this is.
     *
     * While the workflow is stamping rows this list is re-read every couple of seconds, and rows
     * that re-sorted as verdicts landed would move out from under the reader on every tick. Held
     * in import order the row stays put and its badge fills in underneath, which is the whole
     * effect: you watch your file being decided.
     *
     * Once it stops moving that reason is gone, and import order becomes the problem instead —
     * the four matches of a 320-row run are scattered across 13 pages and the first screen is
     * whichever names happened to be inserted first.
     *
     * All three sorts are real here now that the match's score comes back with it. `similarity`
     * ranks every row by closeness; `status` brings the matches up and orders them by closeness
     * within, so the strongest match is the first thing on the page rather than whichever name the
     * file happened to list first. On a run whose matcher recorded no score both fall back to
     * `friend.id`, which is the old behaviour exactly — and the client does not offer "Best match"
     * there at all (see ComparisonProgress.hasSimilarity).
     */
    const byScore = sql`best.similarity desc nulls last`;
    const ordered =
      sort === "similarity"
        ? selected.orderBy(byScore).orderBy("friend.id", "asc")
        : sort === "status"
          ? selected
              .orderBy(sql`case when ${verdict} = ${sql.val("matched")} then 0 else 1 end`)
              .orderBy(byScore)
              .orderBy("friend.id", "asc")
          : selected.orderBy("friend.id", "asc");

    const [data, countResult] = await Promise.all([
      ordered.limit(limit).offset(offset).execute(),
      count.select(db.fn.countAll().as("count")).executeTakeFirst(),
    ]);

    const total = Number(countResult?.count) || 0;
    return {
      data: data.map((r) => toRunRow("facebook", r as RawRunRow)),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  /**
   * Every friend, with the owner whose relationship they are — the left-hand side of a
   * comparison. Deliberately not paginated: the matcher scores the whole table in one
   * pass, and it only carries the columns scoring needs.
   *
   * One name, which is both what gets scored and what gets written into the result row. The
   * results table therefore shows the cleaned spelling rather than the file's — the raw text
   * is not stored, so there is nothing else it could show.
   *
   * The `upload` join is gone with the owner column: this used to reach through it for
   * `uploaded_by`, which is now the wrong person as well as the wrong table.
   *
   * ── `sources` NARROWS THE RUN ──
   *
   * NULL is every friend on file, which is what this method did unconditionally before the
   * parameter existed and is still the default a caller with no opinion gets. A non-null list
   * restricts the run to friends imported from those sources — the "compare my LinkedIn
   * connections against this company" case.
   *
   * Folded on both sides. The stored column is free text written by the import AND by the Database
   * console, so 'Facebook' and 'facebook' are on rows in the same table; `idx_friend_source` is
   * built on `lower(source)` to match, and the caller has already folded the list
   * (`normalizeSources`).
   *
   * THIS FILTERS WHAT IS SCORED, NEVER WHAT IS STORED — the same rule `compare_by`'s language axis
   * follows. A friend left out of this run is still on file, still in every roster and count, and
   * still available to the next run that names their source.
   *
   * An empty array is NOT accepted as "everything": the caller normalises empty to null long before
   * here, and if one arrived it would correctly score nobody. That is why the parameter is
   * `string[] | null` and not `string[]` — the two states have to stay distinguishable in the type.
   */
  static async findAllForMatching(sources: string[] | null = null): Promise<
    {
      id: string;
      friend_name_en: string | null;
      friend_name_th: string | null;
      relationship_owner: string | null;
    }[]
  > {
    const db = await this.getKyselyDB();
    let q = db
      .selectFrom("friend")
      .select([
        // The id comes back so the matcher can stamp `comparison_result.friend_id` — identity,
        // which makes counting exact instead of a name join that two spellings can double.
        "friend.id as id",
        "friend.friend_name_en as friend_name_en",
        "friend.friend_name_th as friend_name_th",
        "friend.relationship_owner as relationship_owner",
      ]);

    if (sources !== null) {
      // `= any(array)` rather than Kysely's `in`: the left side is a raw expression
      // (`lower(...)`), which `in` cannot type against a list of plain strings. Postgres plans
      // this the same way and it uses `idx_friend_source`.
      q = q.where(sql<boolean>`lower(friend.source) = any(${sql.val(sources)}::text[])`);
    }

    return q.orderBy("friend.id", "asc").execute() as never;
  }

  /**
   * How many friends each source holds — the counts beside the options in the source picker.
   *
   * They are the reason the picker is worth having rather than a list of words: "LinkedIn (318)"
   * beside "Facebook (1,204)" tells the user what narrowing the run will actually cost them, and
   * a source sitting at 0 explains a run that came back empty before they start it rather than
   * after.
   *
   * Counted over FRIEND ROWS, unlike `UploadSourceModel.list`'s `useCount`, which counts imports.
   * The two answer different questions and both are right for their own screen: deleting an entry
   * from the pick-list is about how many imports would be affected, while choosing what to compare
   * is about how many people are in play. Neither number belongs on the other's screen.
   *
   * Folded, so a console-written 'Facebook' counts toward the picker's 'facebook' rather than
   * appearing as a separate option nobody can select.
   */
  static async countBySource(): Promise<Record<string, number>> {
    const db = await this.getKyselyDB();
    const rows = await db
      .selectFrom("friend")
      .select([sql<string>`lower(friend.source)`.as("source"), sql<string>`count(*)`.as("count")])
      .where("friend.source", "is not", null)
      .groupBy(sql`lower(friend.source)`)
      .execute();

    const out: Record<string, number> = {};
    for (const r of rows as { source: string | null; count: string }[]) {
      if (r.source) out[r.source] = Number(r.count) || 0;
    }
    return out;
  }

  /** Newest import first. `source_timestamp` ("friended on") used to lead this ordering; it is
   *  gone, and `id` descending is the honest remaining answer — most recently imported first,
   *  which is what someone opening the grid after an upload is looking for. */
  static async findAllPaginated(page: number, limit: number): Promise<PaginatedResult<FacebookDataRow>> {
    const db = await this.getKyselyDB();
    const offset = (page - 1) * limit;
    const [data, countResult] = await Promise.all([
      db
        .selectFrom("friend")
        .leftJoin("upload", "upload.id", "friend.upload_id")
        .select(friendRowSelect as never)
        .orderBy("friend.id", "desc")
        .limit(limit)
        .offset(offset)
        .execute(),
      db.selectFrom("friend").select(db.fn.count("id").as("count")).executeTakeFirst(),
    ]);
    const total = Number(countResult?.count) || 0;
    return { data: data as unknown as FacebookDataRow[], pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  /** Every row one import added — the payload forwarded to the ingestion webhook. */
  static async findByUploadId(uploadId: string): Promise<FacebookDataRow[]> {
    const db = await this.getKyselyDB();
    const rows = await db
      .selectFrom("friend")
      .leftJoin("upload", "upload.id", "friend.upload_id")
      .select(friendRowSelect as never)
      .where("friend.upload_id", "=", uploadId)
      .orderBy("friend.id", "asc")
      .execute();
    return rows as unknown as FacebookDataRow[];
  }

  /** Rows contributed by one upload. */
  static async findByUploadIdPaginated(uploadId: string, page: number, limit: number): Promise<PaginatedResult<FacebookDataRow>> {
    const db = await this.getKyselyDB();
    const offset = (page - 1) * limit;
    const [data, countResult] = await Promise.all([
      db
        .selectFrom("friend")
        .leftJoin("upload", "upload.id", "friend.upload_id")
        .select(friendRowSelect as never)
        .where("friend.upload_id", "=", uploadId)
        .orderBy("friend.id", "asc")
        .limit(limit)
        .offset(offset)
        .execute(),
      db.selectFrom("friend").select(db.fn.count("id").as("count")).where("upload_id", "=", uploadId).executeTakeFirst(),
    ]);
    const total = Number(countResult?.count) || 0;
    return { data: data as unknown as FacebookDataRow[], pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  static async count(): Promise<number> {
    const db = await this.getKyselyDB();
    const row = await db.selectFrom("friend").select(db.fn.count("id").as("count")).executeTakeFirst();
    return Number(row?.count) || 0;
  }

  static async deleteAll(): Promise<number> {
    const db = await this.getKyselyDB();
    const result = await db.deleteFrom("friend").executeTakeFirst();
    return Number(result?.numDeletedRows ?? 0);
  }

  /** Undo an import — delete exactly the rows it added. */
  static async deleteByUploadId(uploadId: string): Promise<number> {
    const db = await this.getKyselyDB();
    const result = await db.deleteFrom("friend").where("upload_id", "=", uploadId).executeTakeFirst();
    return Number(result?.numDeletedRows ?? 0);
  }

  static async deleteById(id: string): Promise<number> {
    if (!/^\d+$/.test(id)) return 0; // non-numeric bigint id: nothing to delete
    const db = await this.getKyselyDB();
    const result = await db.deleteFrom("friend").where("id", "=", id).executeTakeFirst();
    return Number(result?.numDeletedRows ?? 0);
  }
}
