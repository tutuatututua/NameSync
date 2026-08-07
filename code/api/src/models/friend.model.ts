import { randomUUID } from "node:crypto";
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
import type { KnownOnFile, PriorImport } from "./upload.model";
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
import {
  rowFilterWhere,
  rowSearchWhere,
  toRunRow,
  type RawRunRow,
  type RunRowFilter,
  type RunRowSort,
} from "./run-rows";

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
 * So a row matching an existing one on the same owner and EITHER non-null spelling IS that friend.
 *
 * ── WHAT THAT MATCH NOW DOES: assign identity, not refuse the row (2026-08-04) ──
 *
 * IMPORTS STACK. Every row of every import is inserted, under that import's own `upload_id`, and
 * the match above decides which `person_key` it carries rather than whether it is written at all.
 *
 * This is not a preference. The external workflow selects what to match with
 * `WHERE upload_id = :session_id` — it does not read the CSV we send as its work list. A row that
 * was skipped as a duplicate therefore sat under an EARLIER upload where the workflow could not
 * see it, and three bugs followed: re-importing the same people to ask a different question opened
 * no run at all (the "How to compare" was silently dropped); a partly-overlapping file scored only
 * its genuinely new rows while reporting a clean run; and enriched rows were reset to 'processing'
 * and then never stamped by anyone, holding later runs' pending counts open forever.
 *
 * Stacking makes an import's row set complete by construction, which is the one property that
 * workflow behaviour requires. See docs/migrations/2026-08-04-stack-imports-and-person-key.sql.
 *
 * ── Dedup moved to read time ──
 *
 * `person_key` is one uuid shared by every row that is the same person, and `friend_current` folds
 * on it. A question about PEOPLE reads the view; a question about an IMPORT or a RUN reads this
 * table. Getting that backwards is the failure mode to watch for, in both directions: folding a
 * run's rows breaks progress counting, and NOT folding a people question inflates every count in
 * the Network workspace — silently, and in the flattering direction.
 *
 * ── The conflict rule survives, by a different mechanism ──
 *
 * An import may not CHANGE a spelling already on file. It never could, and now it structurally
 * cannot: it writes its own row and leaves every earlier one untouched. What decides the person's
 * displayed name is the fold, which takes the OLDEST non-null spelling per language — so the first
 * spelling recorded still wins, exactly as fill-only produced before.
 *
 * That matters for the same reason it always did: result rows written without `friend_id` — every
 * external-workflow row, and everything predating that column — resolve back to their friend BY
 * NAME. Under stacking a conflicting spelling's row is still on file, still carrying the shared
 * `person_key`, so name resolution finds it and lands on the right person either way. A conflict is
 * still counted and reported; the Database console stays the visible way to change a stored name.
 *
 * ── Two things this does NOT merge ──
 *
 * The same person under a DIFFERENT owner is a different `person_key`, not a duplicate. One person
 * known by three colleagues is three rosters and three ways to reach them, which is the product.
 *
 * Two spellings that share no common name — an English-only row and a Thai-only row for one
 * person — cannot be linked, because nothing in the data says they are the same. A later row
 * carrying BOTH names does link them, and when it does the two existing groups are merged into
 * one: see the union-find in `mergeUpload`.
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
 * ── THE EXACT-DUPLICATE KEY — every column, plus who imported it ──
 *
 * A DIFFERENT question from `spellKey` above, and both are needed. Identity asks "is this the same
 * human", and answers it loosely on purpose (either spelling, same owner) so one person known by
 * two names folds to one roster entry. THIS asks "is this row already in the table, verbatim, from
 * this person" — answered strictly, because it decides whether to WRITE, and a loose answer there
 * discards data somebody meant to keep.
 *
 * So a friend whose Thai spelling arrived in a later file is NOT a duplicate of the row that held
 * only their English name: the rows differ, the second carries something the first did not, and
 * dropping it would lose the spelling. They are still one PERSON — `person_key` says so.
 *
 * Folded throughout, because every column here is either stored folded already (the two names, by
 * the cleaner) or is free text a human typed that the whole product compares case-insensitively
 * (`relationship_owner`, `source`, `uploaded_by`).
 */
const dupKey = (
  by: string | null,
  src: string | null,
  owner: string | null,
  en: string | null,
  th: string | null
): string =>
  JSON.stringify([
    by?.toLowerCase() ?? null,
    src?.toLowerCase() ?? null,
    owner?.toLowerCase() ?? null,
    en?.toLowerCase() ?? null,
    th?.toLowerCase() ?? null,
  ]);

/** A prior row, as both readers of the duplicate rule select it. */
interface PriorFriendRow {
  relationship_owner: string | null;
  friend_name_en: string | null;
  friend_name_th: string | null;
  source: string | null;
  uploaded_by: string | null;
  upload_status: string | null;
}

/**
 * WHICH ROWS OF THIS FILE WOULD BE DROPPED — one answer, two callers.
 *
 * `mergeUpload` uses it to decide what to insert; the import pre-check uses it to tell the user
 * before they commit. They MUST agree: a screen that marks three rows as "will be dropped" over an
 * import that drops five is worse than one that says nothing at all, and the only way two callers
 * cannot disagree is for there to be one function.
 *
 * Pure, and takes the prior rows rather than fetching them, so `mergeUpload` reuses the scan it
 * already does for identity instead of paying for a second one on a 40,000-row import.
 *
 * The mask is built in FILE ORDER and grows as it goes, so a file naming the same row twice drops
 * its own repeat as well as a repeat of the table — the second occurrence is, by then, "already on
 * file, verbatim".
 *
 * Rolled-back rows are skipped: rollback hard-deletes them, so they are not on file to duplicate.
 * A row whose upload is gone carries `uploaded_by: null` and matches nothing, which is right — it
 * cannot be anybody's second copy if nobody is on record as having imported it.
 */
export const friendDropMask = (
  prior: PriorFriendRow[],
  records: FriendRecord[],
  source: string,
  uploadedBy: string | null
): boolean[] => {
  const onFile = new Set<string>();
  for (const p of prior) {
    if (p.upload_status === "rolled_back") continue;
    onFile.add(dupKey(p.uploaded_by, p.source, p.relationship_owner, p.friend_name_en, p.friend_name_th));
  }
  return records.map((r) => {
    const k = dupKey(uploadedBy, source, r.relationship_owner, r.friend_name_en, r.friend_name_th);
    if (onFile.has(k)) return true;
    onFile.add(k);
    return false;
  });
};

/** What one merge did. */
export interface MergeResult {
  /**
   * Rows WRITTEN — the file's usable rows minus the ones dropped as exact duplicates.
   *
   * The size of the job handed to the matcher, and what `upload.total_records` stores and a run's
   * `scoredCount` is read from. It is therefore also the size of what the run can ever say
   * anything about: a dropped row is filed under an EARLIER upload, and the external workflow
   * selects with `WHERE upload_id = :session_id`, so this run will not cover it. That is the
   * deliberate trade of dropping (2026-08-05) — see the note on `duplicates`.
   */
  added: number;
  /**
   * Rows DROPPED — already on file, verbatim, from this same uploader. Not written.
   *
   * ── THIS MEANING HAS NOW CHANGED TWICE, SO READ IT RATHER THAN ASSUMING ──
   *
   * It counted discarded rows originally; on 2026-08-04 it became purely informational ("describes
   * somebody already on file") when imports began to stack; and on 2026-08-05 it went back to
   * counting discards — but on a much stricter key than the first time. What is dropped now is a
   * row identical in EVERY column, from the same `uploaded_by`. A row that shares a person with one
   * already on file but differs in any column (a spelling the old row lacked, a different source, a
   * different owner, a different importer) is still written, and `person_key` folds it to the same
   * human at read time.
   *
   * That strictness is what makes dropping safe where the 2026-08-04 version was not: the rows it
   * discards carry no information the stored ones lack, so a run that cannot see them is not
   * missing anything the file said. Reported to the person importing and stored on
   * `upload.duplicate_records`.
   */
  duplicates: number;
  /**
   * People this import LINKED that were previously two — a row carrying both spellings arriving
   * after an English-only row and a Thai-only row for one person. Rare, and worth reporting
   * separately from `duplicates` because the roster visibly shrinks when it happens.
   */
  linked: number;
  /**
   * Incoming spellings that DISAGREED with one already on file. Counted and reported, never
   * applied — see the conflict rule in this file's header. The disagreeing row is still stored
   * (everything is); it just does not become the person's displayed name.
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
   * Write an upload's parsed friends — ALL of them — and give each the `person_key` of whoever it
   * turns out to be.
   *
   * Nothing is skipped. That is the change: this used to drop a row whose (owner, either spelling)
   * an earlier import already held, and the dropped row's absence from THIS upload is what made the
   * external workflow — which matches `WHERE upload_id = :session_id` — unable to see it. See the
   * header of this file for the three bugs that produced.
   *
   * `records` arrive with their owners already resolved: the route applied the typed owner over
   * every row when one was given, and refused the import outright if that left any row unowned — so
   * every record here knows whose it is and this never has to look at the parent upload.
   *
   * ── HOW IDENTITY IS DECIDED ──
   *
   * One probe per non-null spelling, against `(lower(owner), name)`. A hit means "this is that
   * person", and the row inherits their key. No hit at all means a new person, and a fresh uuid.
   *
   * A row can hit TWO different people, and that is not a conflict — it is evidence. An English-only
   * row and a Thai-only row for one person are two groups precisely because nothing had ever linked
   * them; a business card carrying both spellings is that link. The two groups are then merged, in
   * the database and in this batch's own bookkeeping, by the union-find below. Doing it any other
   * way (picking one, or filing a third) would leave the roster permanently claiming two people
   * where the data now says one.
   */
  static async mergeUpload(
    uploadId: string,
    source: string,
    records: FriendRecord[],
    /**
     * Who is performing this import — `upload.uploaded_by`, and part of the duplicate key.
     *
     * A row is only dropped as a duplicate of one THIS person already filed. Two people importing
     * the same roster is a fact about the network worth storing twice; one person importing it
     * twice is not. Null (nobody named) can never equal a stored uploader, so nothing is dropped.
     */
    uploadedBy: string | null
  ): Promise<MergeResult> {
    const empty: MergeResult = { added: 0, duplicates: 0, linked: 0, conflicts: 0 };
    if (records.length === 0) return empty;
    const db = await this.getKyselyDB();

    // Only the owners this batch mentions can match, so the prior scan is scoped to them rather
    // than reading the whole table — one query however many owners the file names, not one per
    // owner. Folded, because the key is folded.
    const owners = [...new Set(records.map((r) => r.relationship_owner))];
    const named = [...new Set(owners.filter((o): o is string => o !== null).map((o) => o.toLowerCase()))];
    // A record with no owner only ever matches other ownerless rows. Unreachable from the import
    // (a social import is refused without an owner), but the Database console can write one.
    const hasUnowned = owners.includes(null);

    /**
     * The prior rows, plus the two facts the DUPLICATE key needs that the identity key does not:
     * this row's own `source`, and who imported it.
     *
     * LEFT JOIN, not inner: a row whose `upload` has gone (an import discarded mid-flight) is
     * still on file and still folds into its person, it simply cannot be anybody's duplicate —
     * `uploaded_by` comes back null and matches no incoming row. Filtering it out instead would
     * quietly drop it from the identity fold too, which is a different and much worse change.
     */
    const prior = await db
      .selectFrom("friend")
      .leftJoin("upload", "upload.id", "friend.upload_id")
      .select([
        "friend.person_key",
        "friend.relationship_owner",
        "friend.friend_name_en",
        "friend.friend_name_th",
        "friend.source",
        "upload.uploaded_by as uploaded_by",
        "upload.status as upload_status",
      ])
      .where((eb) =>
        eb.or([
          ...(named.length > 0 ? [eb(sql<string>`lower(friend.relationship_owner)`, "in", named)] : []),
          ...(hasUnowned ? [eb("friend.relationship_owner", "is", null)] : []),
        ])
      )
      .execute();

    /** What we know each person is called — the conflict test, and what a merge has to carry over. */
    const spellings = new Map<string, { en: Set<string>; th: Set<string> }>();

    /**
     * Union-find over `person_key`, so a merge is recorded once and every reference to the losing
     * key resolves through it afterwards — including references taken BEFORE the merge happened.
     *
     * Rewriting a map in place would not be enough: rows earlier in this same file may already
     * carry the losing key, and they are not written until the end. Resolving at read time lands
     * them on the winner without a second pass.
     */
    const parent = new Map<string, string>();
    const find = (k: string): string => {
      const p = parent.get(k);
      if (p === undefined || p === k) return k;
      const root = find(p);
      parent.set(k, root); // path compression
      return root;
    };
    const union = (a: string, b: string): boolean => {
      const ra = find(a);
      const rb = find(b);
      if (ra === rb) return false;
      // Lexicographically smallest wins, purely so the outcome does not depend on row order: two
      // imports of the same file must pick the same survivor.
      const [winner, loser] = ra < rb ? [ra, rb] : [rb, ra];
      parent.set(loser, winner);
      // The loser's names come too, or the conflict test would stop seeing half of what this
      // person is called the moment two groups merged.
      const ls = spellings.get(loser);
      if (ls) {
        const ws = spellings.get(winner) ?? { en: new Set<string>(), th: new Set<string>() };
        for (const n of ls.en) ws.en.add(n);
        for (const n of ls.th) ws.th.add(n);
        spellings.set(winner, ws);
        spellings.delete(loser);
      }
      return true;
    };

    /** Every stored spelling is a way in to its person. Two entries per bilingual row, one value. */
    const keyBySpelling = new Map<string, string>();

    const note = (key: string, owner: string | null, lang: CompareLanguage, name: string | null) => {
      if (!name) return;
      const root = find(key);
      let s = spellings.get(root);
      if (!s) {
        s = { en: new Set<string>(), th: new Set<string>() };
        spellings.set(root, s);
      }
      s[lang].add(name);
      keyBySpelling.set(spellKey(owner, lang, name), root);
    };

    for (const p of prior) {
      const key = p.person_key as string;
      note(key, p.relationship_owner, "en", p.friend_name_en);
      note(key, p.relationship_owner, "th", p.friend_name_th);
    }

    /**
     * Which rows this file will NOT write — computed once, from the same function the import
     * pre-check answered the preview with. See `friendDropMask`.
     */
    const drop = friendDropMask(prior, records, source, uploadedBy);

    // Both sides keyed the same way, which is the only reason this is correct: stored names and
    // incoming names have been through the same cleaner, so they compare directly.
    const probe = (r: FriendRecord): string[] => {
      const hits = new Set<string>();
      for (const lang of LANGS) {
        const name = r[NAME_COL[lang]];
        if (!name) continue;
        const hit = keyBySpelling.get(spellKey(r.relationship_owner, lang, name));
        if (hit) hits.add(find(hit));
      }
      return [...hits];
    };

    /** The rows that will actually be written, with the person each resolved to. */
    const toInsert: { record: FriendRecord; key: string }[] = [];
    let duplicates = 0;
    let linked = 0;
    let conflicts = 0;

    for (const [i, r] of records.entries()) {
      /**
       * ALREADY HERE, VERBATIM, FROM THIS PERSON — dropped rather than written.
       *
       * Checked before anything else in the loop, and added to the set as we go, so a file naming
       * the same row twice drops its own repeat as well as a repeat of the table. `continue` skips
       * the identity work too, which is correct: this row says nothing the stored one did not, so
       * there is no spelling to note and nothing that could link two people.
       */
      if (drop[i]) {
        duplicates += 1;
        continue;
      }

      const hits = probe(r);

      let key: string;
      if (hits.length === 0) {
        key = randomUUID();
      } else {
        key = hits[0] as string;
        // The linking case. Every extra group this row touched is the same person as the first,
        // and this row is the evidence that says so.
        for (const other of hits.slice(1)) {
          if (union(key, other)) linked += 1;
        }
        key = find(key);
        // NOT counted as a duplicate. This row names somebody already on file but is not the same
        // ROW — a new spelling, a new source, a different importer — so it is written, and
        // `person_key` is what folds the two into one person at read time. `duplicates` counts only
        // what was dropped; see `MergeResult`.
      }

      // "Do we already hold a DIFFERENT name for this person in this language?" — the same question
      // the fill-only rule asked before refusing to overwrite. Asked BEFORE this row's own
      // spellings are recorded, or it would always agree with itself.
      const known = spellings.get(key);
      if (known) {
        for (const lang of LANGS) {
          const incoming = r[NAME_COL[lang]];
          if (!incoming) continue;
          if (known[lang].size > 0 && !known[lang].has(incoming)) conflicts += 1;
        }
      }

      // Register this row's spellings, so a LATER row in this same file carrying only one of them
      // resolves to the same person instead of starting a second one.
      note(key, r.relationship_owner, "en", r.friend_name_en);
      note(key, r.relationship_owner, "th", r.friend_name_th);
      toInsert.push({ record: r, key });
    }

    // Every row of this file was already here, verbatim, from this person. Nothing to write — and
    // the caller turns that into a refusal rather than an empty import (see `enforcePrecheck`).
    if (toInsert.length === 0) return { added: 0, duplicates, linked, conflicts };

    /**
     * Apply the merges to rows already in the database.
     *
     * Only groups that actually LOST — `find(k) !== k` — need touching. A batch that linked nothing
     * runs no statement at all, which is the overwhelmingly common case.
     */
    const losers = [...new Set(prior.map((p) => p.person_key as string))].filter((k) => find(k) !== k);
    if (losers.length > 0) {
      const moves = sql.join(losers.map((k) => sql`(${sql.val(k)}::uuid, ${sql.val(find(k))}::uuid)`));
      await sql`
        update friend as f
           set person_key = v.to_key
          from (values ${moves}) as v(from_key, to_key)
         where f.person_key = v.from_key
      `.execute(db);
    }

    // Everything, in one statement. `assigned` is resolved through `find` HERE rather than when it
    // was pushed, so a row given a key that later lost a union still lands on the winner.
    await db
      .insertInto("friend")
      .values(
        toInsert.map(({ record, key }) => ({
          upload_id: uploadId,
          source,
          friend_name_en: record.friend_name_en,
          friend_name_th: record.friend_name_th,
          relationship_owner: record.relationship_owner,
          person_key: find(key),
        }))
      )
      .execute();

    return { added: toInsert.length, duplicates, linked, conflicts };
  }

  /**
   * WHICH ROWS OF THIS FILE WOULD BE DROPPED — the pre-check's answer, before anything is written.
   *
   * Returns a mask in file order, so the preview can mark the actual rows on screen rather than
   * printing a number and leaving the reader to work out which ones it meant. `mergeUpload` derives
   * its inserts from the same function (`friendDropMask`), so what the screen marks and what the
   * import drops cannot come apart.
   *
   * `source` is a parameter because it is part of the key and the import defaults it — a friends
   * import with no type chosen stores 'facebook', so the preview has to ask about 'facebook' too or
   * it would compare the file against rows filed under a source it is not going to use.
   */
  static async dropMask(
    records: FriendRecord[],
    source: string,
    uploadedBy: string | null
  ): Promise<boolean[]> {
    if (records.length === 0) return [];
    const db = await this.getKyselyDB();

    const owners = [...new Set(records.map((r) => r.relationship_owner))];
    const named = [...new Set(owners.filter((o): o is string => o !== null).map((o) => o.toLowerCase()))];
    const hasUnowned = owners.includes(null);

    const prior = await db
      .selectFrom("friend")
      .leftJoin("upload", "upload.id", "friend.upload_id")
      .select([
        "friend.relationship_owner",
        "friend.friend_name_en",
        "friend.friend_name_th",
        "friend.source",
        "upload.uploaded_by as uploaded_by",
        "upload.status as upload_status",
      ])
      .where((eb) =>
        eb.or([
          ...(named.length > 0 ? [eb(sql<string>`lower(friend.relationship_owner)`, "in", named)] : []),
          ...(hasUnowned ? [eb("friend.relationship_owner", "is", null)] : []),
        ])
      )
      .execute();

    return friendDropMask(prior, records, source, uploadedBy);
  }

  /**
   * How many of these parsed records name somebody ALREADY ON FILE — and which import filed them.
   *
   * The import pre-check's numerator — see `ImportPrecheckSchema`. Asked before anything is
   * written, so the preview screen can say "80 of these 100 people are already on file" and the
   * import can refuse a repeat that adds nothing.
   *
   * Uses the SAME probe as `mergeUpload` — same owner, either spelling — because the two have to
   * agree about who is already known or the screen's count and the import's behaviour describe
   * different files. Records within the batch are folded too: a file naming one person twice
   * contributes one to `known` if they are on file, and nothing if they are not, which is what
   * makes `known === importable` a truthful "all of these are already here".
   *
   * ── `uploadedBy` NARROWS "ON FILE" TO "ON FILE FROM YOU" ──
   *
   * The blocking half of the pre-check (see `ImportPrecheckSchema`). Omitted, this answers "does
   * anyone hold these people" — the question the `partial` / `repeat` wording is built on. Given a
   * name, it answers "did THIS person already file them", which is the one the refusal turns on:
   * two people importing the same roster is a fact worth recording, one person importing it twice
   * is not.
   *
   * Rolled-back imports are excluded, and the exclusion is belt-and-braces rather than decorative:
   * a rollback hard-deletes its rows, so they are not on file to be counted — but an import whose
   * rows were undone must not go on refusing the re-import that undoing it was the preparation for,
   * and stating that here means the rule does not depend on how rollback happens to be implemented.
   *
   * Folded, because `uploaded_by` is free text the import screen prefills from a session and lets
   * the user edit — "Alex" and "alex" are one person everywhere else in the product.
   */
  static async countKnown(
    records: FriendRecord[],
    opts: { uploadedBy?: string | null } = {}
  ): Promise<KnownOnFile> {
    const none: KnownOnFile = { known: 0, priorImport: null };
    if (records.length === 0) return none;
    // Nobody named cannot have imported anything, so nothing is "already yours". Distinct from
    // omitting the option, which asks about everybody.
    if ("uploadedBy" in opts && !opts.uploadedBy) return none;
    const db = await this.getKyselyDB();

    const owners = [...new Set(records.map((r) => r.relationship_owner))];
    const named = [...new Set(owners.filter((o): o is string => o !== null).map((o) => o.toLowerCase()))];
    const hasUnowned = owners.includes(null);

    // The import each stored row came in on, joined rather than looked up afterwards: the refusal
    // has to NAME the import it is refusing over, and a second query keyed on "the newest import by
    // this uploader" would name a different file whenever they imported something else since.
    //
    // INNER JOIN, so a row whose import was deleted is not on file for this purpose. That is the
    // right direction: `discardImport` and the rollback path both remove the import, and a row
    // outliving one is a row nothing can hold the user to.
    let priorQuery = db
      .selectFrom("friend")
      .innerJoin("upload", "upload.id", "friend.upload_id")
      .select([
        "friend.relationship_owner",
        "friend.friend_name_en",
        "friend.friend_name_th",
        "upload.id as upload_id",
        "upload.name as upload_name",
        "upload.uploaded_by as uploaded_by",
        "upload.created_at as upload_created_at",
      ])
      .where("upload.status", "!=", "rolled_back")
      .where((eb) =>
        eb.or([
          ...(named.length > 0 ? [eb(sql<string>`lower(friend.relationship_owner)`, "in", named)] : []),
          ...(hasUnowned ? [eb("friend.relationship_owner", "is", null)] : []),
        ])
      );

    if (opts.uploadedBy) {
      const who = opts.uploadedBy.toLowerCase();
      priorQuery = priorQuery.where(sql<boolean>`lower(upload.uploaded_by) = ${sql.val(who)}`);
    }

    const prior = await priorQuery.execute();

    // Spelling → the import that filed it. Newest wins, so the message names the most recent time
    // this happened rather than the first — which is the one the reader remembers doing.
    const onFile = new Map<string, PriorImport>();
    for (const p of prior) {
      const from: PriorImport = {
        id: String(p.upload_id),
        name: p.upload_name,
        uploaded_by: p.uploaded_by,
        created_at: String(p.upload_created_at),
      };
      const note = (key: string): void => {
        const held = onFile.get(key);
        if (!held || held.created_at < from.created_at) onFile.set(key, from);
      };
      if (p.friend_name_en) note(spellKey(p.relationship_owner, "en", p.friend_name_en));
      if (p.friend_name_th) note(spellKey(p.relationship_owner, "th", p.friend_name_th));
    }

    // Counted over distinct PEOPLE in the file, not over rows, for the reason in the doc above.
    const seen = new Set<string>();
    let known = 0;
    let priorImport: PriorImport | null = null;
    for (const r of records) {
      const keys = LANGS.map((lang) => {
        const name = r[NAME_COL[lang]];
        return name ? spellKey(r.relationship_owner, lang, name) : null;
      }).filter((k): k is string => k !== null);
      if (keys.length === 0) continue;
      if (keys.some((k) => seen.has(k))) continue; // already counted this person from an earlier row
      keys.forEach((k) => seen.add(k));
      const from = keys.map((k) => onFile.get(k)).find((f): f is PriorImport => f !== undefined);
      if (!from) continue;
      known += 1;
      if (!priorImport || priorImport.created_at < from.created_at) priorImport = from;
    }
    return { known, priorImport };
  }

  /**
   * Has the friend side of a run moved since `since`?
   *
   * This is what makes "you already ran this" a REFUSAL rather than a note (2026-08-06). Repeating
   * a run whose inputs have not moved can only reproduce the answer already on file, so the compare
   * dialog disables its button and `POST /compare` 409s — but the moment a friend lands, the same
   * question has a new answer waiting and the run has to become askable again. That "moment" is
   * exactly this query, and getting it wrong in the strict direction traps the user with no way out
   * but deleting a good run.
   *
   * ── IT ASKS ABOUT *THIS RUN'S* FRIENDS, NOT ABOUT THE TABLE ──
   *
   * `sources` and `scope` are the same narrowing `findAllForMatching` applies, and they are here
   * for the same reason they are there: a LinkedIn run is not re-asked by a Facebook import, and
   * Alex's roster is not re-asked by an import filed under Mint. A table-wide test would unblock
   * every repeat run in the product on any import at all, which is the feature not existing.
   *
   * Keep the two in step. If the definition of "who is in this run" changes in
   * `findAllForMatching`, it has to change here too, or the block will outlive the answer it is
   * protecting — the failure mode being a user who imports the friends they were told to import and
   * still cannot run.
   *
   * The narrowing is asked of the PERSON (any of their raw rows matches) and the change is asked of
   * their rows — so a second import that only adds a Thai spelling to somebody already in the run
   * counts, which is right: the fold the matcher scores now reads differently.
   *
   * `updated_at` as well as `created_at`, because a renamed row is as much a change as a new one:
   * the Database console can rename a friend, and the run that scored the old spelling is stale.
   *
   * A DELETION is NOT detected — a rolled-back import leaves no row to have a timestamp, so a run
   * whose friends went away stays blocked until something is added. That is the trapping direction
   * and it is accepted knowingly: the alternative is storing a row count per run and comparing it,
   * which buys one rare case for a column that can silently disagree with the table it counts.
   */
  static async changedSince(
    since: string,
    sources: string[] | null = null,
    scope: { owner?: string | null; uploadId?: string | null } = {}
  ): Promise<boolean> {
    const db = await this.getKyselyDB();
    // The fold, like `findAllForMatching` — the question is about the people a run covers, and a
    // person is covered once, however many times they have been imported.
    let q = db.selectFrom("friend_current").select("friend_current.person_key as person_key");

    // ── The three narrowings, as `findAllForMatching` states them. See there for why each is asked
    //    of the raw rows rather than of the fold's collapsed value.
    if (sources !== null) {
      q = q.where(({ exists, selectFrom }) =>
        exists(
          selectFrom("friend")
            .select("friend.id")
            .whereRef("friend.person_key", "=", "friend_current.person_key")
            .where(sql<boolean>`lower(friend.source) = any(${sql.val(sources)}::text[])`)
        )
      );
    }

    if (scope.owner) {
      const owner = scope.owner.toLowerCase();
      q = q.where(({ exists, selectFrom }) =>
        exists(
          selectFrom("friend")
            .select("friend.id")
            .whereRef("friend.person_key", "=", "friend_current.person_key")
            .where(sql<boolean>`lower(friend.relationship_owner) = ${sql.val(owner)}`)
        )
      );
    }

    if (scope.uploadId) {
      q = q.where(({ exists, selectFrom }) =>
        exists(
          selectFrom("friend")
            .select("friend.id")
            .whereRef("friend.person_key", "=", "friend_current.person_key")
            .where("friend.upload_id", "=", scope.uploadId as string)
        )
      );
    }

    const row = await q
      .where(({ exists, selectFrom }) =>
        exists(
          selectFrom("friend")
            .select("friend.id")
            .whereRef("friend.person_key", "=", "friend_current.person_key")
            .where((eb) =>
              eb.or([
                eb("friend.created_at", ">", since as never),
                eb("friend.updated_at", ">", since as never),
              ])
            )
        )
      )
      .limit(1)
      .executeTakeFirst();
    return row !== undefined;
  }

  /**
   * How many friends are on file — PEOPLE, not rows.
   *
   * Reads the fold. Since imports stack, the raw row count is "how many times somebody has been
   * imported", which is not a number anyone has ever wanted on the Data page: re-importing one
   * file twice would double it while the roster below it stayed the same length.
   */
  static async stats(): Promise<{ total: number }> {
    const db = await this.getKyselyDB();
    const row = await db
      .selectFrom("friend_current")
      .select(db.fn.count("person_key").as("count"))
      .executeTakeFirst();
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
    threshold: number | null = null,
    /**
     * The search box's text, or null. Matched against the friend's two spellings and whose
     * relationship they are — the row's own columns, so the count below is built from the same
     * predicate as the page. See `rowSearchWhere`.
     */
    q: string | null = null
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
    const search = rowSearchWhere(
      ["friend.friend_name_en", "friend.friend_name_th", "friend.relationship_owner"],
      q
    );

    let rows = db.selectFrom("friend").where("friend.upload_id", "=", uploadId);
    if (where) rows = rows.where(where);
    if (search) rows = rows.where(search);

    let count = db.selectFrom("friend").where("friend.upload_id", "=", uploadId);
    if (where) count = count.where(where);
    if (search) count = count.where(search);

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
   *
   * ── `scope` NARROWS IT AGAIN, ON A DIFFERENT AXIS ──
   *
   * The run's `filter_by` / `filter_value`, for the two kinds that select friends: one relationship
   * owner, or one past import. It composes with `sources` rather than replacing it — "Alex's
   * LinkedIn friends" is a legal and useful run — and both narrow the same way, by asking the RAW
   * rows rather than the fold, for the same reason `sources` does: a person can reach the fold
   * through several imports and several owners, and filtering the collapsed value would drop them
   * from a run they belong in because their newest row happened to say something else.
   */
  static async findAllForMatching(
    sources: string[] | null = null,
    scope: { owner?: string | null; uploadId?: string | null } = {}
  ): Promise<
    {
      id: string;
      friend_name_en: string | null;
      friend_name_th: string | null;
      relationship_owner: string | null;
    }[]
  > {
    const db = await this.getKyselyDB();
    // ONE ROW PER PERSON, not per import. Scoring the raw table would score a re-imported friend
    // once per import and write that many result rows for them — the run would report more matches
    // than it has people, which is the inflating direction that never gets reported as a bug.
    //
    // The names are the fold's, so a person whose English spelling came from one import and Thai
    // from another is scored on both. That is what replaces enrichment for the matcher.
    let q = db
      .selectFrom("friend_current")
      .select([
        // The id comes back so the matcher can stamp `comparison_result.friend_id` — identity,
        // which makes counting exact instead of a name join that two spellings can double. It is
        // the person's newest row, which is a real `friend` row and a valid target for the FK.
        "friend_current.id as id",
        "friend_current.friend_name_en as friend_name_en",
        "friend_current.friend_name_th as friend_name_th",
        "friend_current.relationship_owner as relationship_owner",
      ]);

    if (sources !== null) {
      /**
       * "Did this person arrive from any of these sources?" — asked against the RAW rows, not
       * against the fold's `source`.
       *
       * The fold has to collapse `source` to one value (the newest row's), and a person imported
       * from Facebook and later from LinkedIn genuinely belongs to both rosters. Filtering on the
       * collapsed value would drop them from a Facebook-scoped run because their most recent
       * import happened to be the LinkedIn one — a silent, order-dependent omission.
       *
       * `= any(array)` rather than Kysely's `in`: the left side is a raw expression (`lower(...)`),
       * which `in` cannot type against a list of plain strings. Postgres plans it the same way and
       * it uses `idx_friend_source`.
       */
      q = q.where(({ exists, selectFrom }) =>
        exists(
          selectFrom("friend")
            .select("friend.id")
            .whereRef("friend.person_key", "=", "friend_current.person_key")
            .where(sql<boolean>`lower(friend.source) = any(${sql.val(sources)}::text[])`)
        )
      );
    }

    /**
     * "Is any of this person's rows owned by them?" — the `filter_by='owner'` run.
     *
     * Folded, because `relationship_owner` is free text a human types: the app cleans it
     * (`cleanOwnerName`) but preserves case, and every roster in the product already groups it
     * case-insensitively. A run scoped to "Alex" that missed the rows filed under "alex" would
     * report a smaller roster than the page the reader started from.
     *
     * Against the raw rows, not the fold, for the reason in the doc above — an assistant importing
     * a second file for somebody else must not move that person out of their own scoped run.
     */
    if (scope.owner) {
      const owner = scope.owner.toLowerCase();
      q = q.where(({ exists, selectFrom }) =>
        exists(
          selectFrom("friend")
            .select("friend.id")
            .whereRef("friend.person_key", "=", "friend_current.person_key")
            .where(sql<boolean>`lower(friend.relationship_owner) = ${sql.val(owner)}`)
        )
      );
    }

    /**
     * "Did this person arrive in that import?" — the `filter_by='file'` run.
     *
     * The row scored is still the FOLD's (one row per person, carrying whichever spellings they
     * have accumulated), and only the membership test looks at the import. That is the honest
     * reading of "re-compare that file": it is the people that file brought, held against
     * everything now known about them — not a replay of the file's own cells, which would score a
     * person on a spelling a later import has already corrected.
     */
    if (scope.uploadId) {
      q = q.where(({ exists, selectFrom }) =>
        exists(
          selectFrom("friend")
            .select("friend.id")
            .whereRef("friend.person_key", "=", "friend_current.person_key")
            .where("friend.upload_id", "=", scope.uploadId as string)
        )
      );
    }

    return q.orderBy("friend_current.id", "asc").execute() as never;
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
   *
   * PEOPLE per source, counted off the raw table rather than the fold — the one place where doing
   * both is right. `count(distinct person_key)` is what stops a re-import inflating the number the
   * picker shows; the RAW table is what keeps a person who arrived from two sources counted under
   * both, which is true and which `friend_current` cannot say (it collapses `source` to one value).
   */
  static async countBySource(): Promise<Record<string, number>> {
    const db = await this.getKyselyDB();
    const rows = await db
      .selectFrom("friend")
      .select([
        sql<string>`lower(friend.source)`.as("source"),
        sql<string>`count(distinct friend.person_key)`.as("count"),
      ])
      .where("friend.source", "is not", null)
      .groupBy(sql`lower(friend.source)`)
      .execute();

    const out: Record<string, number> = {};
    for (const r of rows as { source: string | null; count: string }[]) {
      if (r.source) out[r.source] = Number(r.count) || 0;
    }
    return out;
  }

  /**
   * How many PEOPLE one relationship owner holds — the owner-scoped run's size, checked before it
   * is started.
   *
   * The sibling of `countBySource` above, and it exists for the same one reason: `POST /compare`
   * refuses a run that can only ever come back empty, because "no friends are filed under Alex" is
   * a far better answer than a run that completes with zero matches and leaves the reader working
   * out which half of their question was empty.
   *
   * Folded on the way in, matching `findAllForMatching`'s own owner filter, so the number checked
   * and the population run are the same set. `count(distinct person_key)` for the reason
   * `countBySource` uses it: a re-imported friend is several rows and one person.
   */
  static async countByOwner(owner: string): Promise<number> {
    const db = await this.getKyselyDB();
    const row = await db
      .selectFrom("friend")
      .select(sql<string>`count(distinct friend.person_key)`.as("count"))
      .where(sql<boolean>`lower(friend.relationship_owner) = ${sql.val(owner.toLowerCase())}`)
      .executeTakeFirst();
    return Number(row?.count) || 0;
  }

  /**
   * Newest import first. `source_timestamp` ("friended on") used to lead this ordering; it is
   * gone, and `id` descending is the honest remaining answer — most recently imported first,
   * which is what someone opening the grid after an upload is looking for.
   *
   * RAW ROWS, deliberately, and the one people-shaped page that does not fold. This is the Data
   * page: a table of what is stored, with the import each row came from beside it. Since imports
   * stack, a re-imported friend is genuinely several rows and hiding them here would make the
   * grid disagree with the database it claims to show — and with rollback, which works on exactly
   * these rows. The count above it (`stats`) folds, because "how many friends do we have" is a
   * question about people; this is a question about rows.
   */
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

  /** How many rows one import added — the friends-side twin of
   *  `CompanyContactModel.countByUploadId`, and replacing `findByUploadId` for the same reason:
   *  the ingestion webhook is told which rows to select rather than handed a copy of them. */
  static async countByUploadId(uploadId: string): Promise<number> {
    const db = await this.getKyselyDB();
    const row = await db
      .selectFrom("friend")
      .select(db.fn.count("id").as("count"))
      .where("upload_id", "=", uploadId)
      .executeTakeFirst();
    return Number(row?.count) || 0;
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

  /** How many friends are on file — PEOPLE, like `stats`. */
  static async count(): Promise<number> {
    const db = await this.getKyselyDB();
    const row = await db
      .selectFrom("friend_current")
      .select(db.fn.count("person_key").as("count"))
      .executeTakeFirst();
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

  /**
   * Delete a friend — every row of them, not one copy. The company-side twin of
   * `CompanyContactModel.deleteById`; see there for why an id that came out of the fold cannot be
   * deleted one row at a time.
   *
   * NOT the same as rolling back an import (`deleteByUploadId`), which removes only that import's
   * own rows and lets the person survive through the others.
   */
  static async deleteById(id: string): Promise<number> {
    if (!/^\d+$/.test(id)) return 0; // non-numeric bigint id: nothing to delete
    const db = await this.getKyselyDB();
    const result = await db
      .deleteFrom("friend")
      .where(
        "person_key",
        "=",
        db.selectFrom("friend as f").select("f.person_key").where("f.id", "=", id)
      )
      .executeTakeFirst();
    return Number(result?.numDeletedRows ?? 0);
  }
}
