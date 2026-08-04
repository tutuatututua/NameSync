import { sql, type RawBuilder, type SqlBool } from "kysely";
import { compareLanguageSql } from "./row-status";

/**
 * "Is this `comparison_result` row about this `friend` row?" — in SQL, in one place.
 *
 * Two readers need it and must not answer it differently: `FriendModel` asks it per row to decide
 * whether an import's friend has a match yet, and `NetworkModel` asks it over the whole table to
 * count distinct friends. A disagreement between them shows up as a page whose tiles do not add up.
 *
 * ── Why it is a disjunction and not a join on one column ──
 *
 * `comparison_result` is written directly by an external workflow we do not control, so the row may
 * carry either of two things:
 *
 *   · `friend_id`    — exact and free, but only on rows the internal matcher wrote since 2026-07-28.
 *   · either spelling — what the matcher writes whichever language ran, and what the callback route
 *                       files an external `fb_name` into by script.
 *
 * Relying on "the matcher will write both spellings" would have been enough for the matcher we own
 * and useless for the workflow we do not: EXTERNAL-MATCHER.md §2b is a plain INSERT with no such
 * requirement, and that workflow already writes off-contract spellings for `status`. So the rule
 * takes whatever is there and needs only ONE of them to be right.
 *
 * A third form used to exist and is why this list shrank: a bare `friend_name`, the single scored
 * spelling, which was all an external row carried. Two more disjuncts matched it against each of
 * `friend`'s columns. 2026-08-03b routed every stored value into the column its script indicates
 * and 2026-08-03c dropped the column, so those rows now arrive at the two disjuncts below —
 * which is the same test, done once at write time instead of on every read.
 *
 * NULL comparisons resolve to NULL and therefore to false, so every absent column drops out of the
 * disjunction on its own — no `is not null` guards needed.
 *
 * ── The owner is the caller's business ──
 *
 * This deliberately does NOT test `upload_name` against `relationship_owner`. One person known by
 * three colleagues is three friend rows with the same name (the dedup key is per owner), so a
 * caller counting a roster MUST add the owner predicate or it will pool all three. A caller asking
 * "does this specific row have a match" already has the row and does not need it. Folding it in
 * here would silently drop matches from external runs that omit `upload_name`, which is exactly the
 * tie-break `findRunRows` is careful to keep out of its WHERE.
 */
export function sameFriendSql(cr: string, friend: string): RawBuilder<SqlBool> {
  const c = (col: string) => sql.ref(`${cr}.${col}`);
  const f = (col: string) => sql.ref(`${friend}.${col}`);
  return sql<SqlBool>`(
    ${c("friend_id")} = ${f("id")}
    or ${c("friend_name_en")} = ${f("friend_name_en")}
    or ${c("friend_name_th")} = ${f("friend_name_th")}
  )`;
}

/**
 * WHICH SPELLING THIS RUN SCORED — the fact `comparison_result.friend_name` used to state outright.
 *
 * That column held one string: the name the matcher actually compared. It is gone (2026-08-03c),
 * so the question is answered from the run's own mode instead — `compare_by` says which language
 * ran, and the row carries that language's spelling.
 *
 * This is a reconstruction and not the original fact, in one specific way worth knowing: where
 * `compare_by` is NULL, `compareLanguageSql` resolves it to the default's language rather than to
 * "unknown", the same coalesce every other reader of that column makes. So a run predating the
 * column reads as English here. That is a guess, where the dropped column was a record.
 *
 * Coalesced rather than strict: a `th` run against a friend we hold only in English still has a
 * name worth showing, and showing the one we have beats showing nothing. Requires the run to be
 * joined — pass the alias its `compare_by` is reachable under.
 */
export function scoredNameSql(cr: string, compareByColumn: string): RawBuilder<string | null> {
  const c = (col: string) => sql.ref(`${cr}.${col}`);
  return sql<string | null>`(case when ${compareLanguageSql(compareByColumn)} = ${sql.val("th")}
    then coalesce(${c("friend_name_th")}, ${c("friend_name_en")})
    else coalesce(${c("friend_name_en")}, ${c("friend_name_th")}) end)`;
}

/**
 * THE SAME PERSON'S OTHER SPELLING, off the result row — the counterpart to `scoredNameSql`.
 *
 * Null when the row carries only one, which is honest: "we have no Thai spelling on this result"
 * is a fact about the evidence, and inventing one from the friend row would be reading identity
 * out of columns that exist to be frozen.
 */
export function otherNameSql(cr: string, compareByColumn: string): RawBuilder<string | null> {
  const c = (col: string) => sql.ref(`${cr}.${col}`);
  return sql<string | null>`(case when ${compareLanguageSql(compareByColumn)} = ${sql.val("th")}
    then ${c("friend_name_en")} else ${c("friend_name_th")} end)`;
}

/**
 * WHICH of several candidate friend rows a result row is about — the tie-break, never a filter.
 *
 * `sameFriendSql` can name more than one row: the dedup key is (owner, name), so one person known by
 * three colleagues is three `friend` rows sharing a name. Something has to pick. This is that
 * something, in the order the evidence deserves:
 *
 *   1. The id the writer supplied. Exact, and settles it outright.
 *   2. The row whose owner the matcher named. A hint, not a fact — see below.
 *   3. The lowest id. Arbitrary but STABLE, which is the only property that matters once the first
 *      two have failed: two reads of the same page must resolve the same friend or the counts move
 *      under the reader.
 *
 * ── Why rule 2 is an ORDER BY and not a WHERE ──
 *
 * It was a WHERE, on `network.model.ts`'s `friendKeyFor`, and the reasoning was sound: pooling three
 * colleagues' copies of one name would over-count a roster. What it assumed is that
 * `comparison_result.upload_name` holds the relationship owner — which the contract does require
 * (docs/EXTERNAL-MATCHER.md §1) and which an external workflow is perfectly capable of getting
 * wrong. Ours did: it wrote `uploader_name`, the person who PERFORMED the import, into that column,
 * which the doc warns against by name.
 *
 * As a WHERE that mistake is silent and total — no friend row resolves, `count(distinct friend)`
 * returns 0, and a company page reports "Connections 0" beside "Reachable by 1" with nothing
 * logged. As an ORDER BY the same mistake costs only the disambiguation: rule 3 picks one friend
 * instead of the right one, the count stays 1 rather than collapsing to 0, and a name shared by
 * three owners still cannot pool, because LIMIT 1 takes exactly one row either way.
 *
 * A predicate that turns a wrong hint into a wrong ANSWER is worse than one that turns it into a
 * worse guess. This is the same "tie-break, not a WHERE" stance `findRunRows` already takes for
 * exactly this column.
 */
export function friendPreferenceSql(cr: string, friend: string): RawBuilder<number> {
  const c = (col: string) => sql.ref(`${cr}.${col}`);
  const f = (col: string) => sql.ref(`${friend}.${col}`);
  return sql<number>`(
    case when ${c("friend_id")} = ${f("id")} then 0
         when ${c("upload_name")} is not null
          and lower(${f("relationship_owner")}) = lower(${c("upload_name")}) then 1
         else 2 end
  )`;
}

/**
 * THE RELATIONSHIP OWNER OF A RESULT ROW — the friend row's own owner, and nothing else.
 *
 * No fallback to `comparison_result.upload_name`. A result this cannot resolve to a friend has no
 * owner as far as every caller of this function is concerned, and says so by being NULL.
 *
 * ── Why there is no fallback, when the obvious design has one ──
 *
 * `upload_name` is documented as the owner (EXTERNAL-MATCHER.md §1) and the internal matcher fills
 * it from `friend.relationship_owner`, so `coalesce(friend, upload_name)` looks strictly better:
 * same answer when they agree, and an answer instead of a blank when the friend row is gone —
 * rolling back an import deletes it and nulls `friend_id` (ON DELETE SET NULL), leaving the result
 * with only its frozen text.
 *
 * It is worse, for a reason specific to what the callers of THIS function do with the name: they
 * render it as a LINK to that person's roster page. A fallback name is by construction a name with
 * no friend rows behind it, so the link it produces is guaranteed to open an empty page — the exact
 * dead end this whole change exists to remove, reintroduced for the one case where it is certain
 * rather than merely possible. And the fallback would fire hardest where it is least trustworthy:
 * a live workflow currently writes the IMPORTER into that column, so on this database every name it
 * could supply is the wrong person.
 *
 * Blank is the honest reading. "We cannot tell you whose friend this was" is true; naming somebody
 * whose roster does not exist is not.
 *
 * ── Where the fallback survives, and why that is not an inconsistency ──
 *
 * `ComparisonResultModel.findByComparisonId` and both `findRunRows` still read
 * `coalesce(<friend lookup>, upload_name)`. They render the name as TEXT IN A CELL, not as a link,
 * so a name that leads nowhere costs nothing there and still tells the reader what the matcher
 * claimed — which on the results payload (whose wire field is literally `upload_name`) is the
 * question being asked. The rule is the split, not an exception to it:
 *
 *   a name that is a LINK must resolve · a name that is a CELL may fall back
 *
 * `friendAlias` is the alias the caller has already resolved the friend row under — this composes
 * with a lateral join rather than issuing a subquery of its own, so a page does not pay for the same
 * lookup twice.
 */
export function ownerSql(friendAlias: string): RawBuilder<string | null> {
  return sql<string | null>`${sql.ref(`${friendAlias}.relationship_owner`)}`;
}
