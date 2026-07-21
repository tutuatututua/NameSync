/**
 * What the external workflow stamps on a single uploaded row, and how both sides read it.
 *
 * Shared because the API tallies these into the counts above the table and the UI renders them
 * into the badges inside it, and if the two disagreed about what `errored` means you would get a
 * header reading "3 no match" over a table showing three rows marked Failed. One vocabulary,
 * imported twice.
 *
 * The column it describes (`friend.status` / `company_contact.status`) has deliberately no CHECK
 * constraint — see docs/EXTERNAL-MATCHER.md. An unexpected value must be *storable*, so both
 * readers here have to cope with one rather than reject it.
 */

/** Accepted but not yet picked up. `comparison_result.status` defaults to this, so a result row
 *  inserted ahead of its verdict reads as unfinished rather than as a silent "no match". */
export const ROW_QUEUED = 'pending';

/** Picked up, not yet decided. The default of `friend.status` / `company_contact.status`, so a row
 *  is unfinished from the moment it is inserted and a crashed workflow leaves rows visibly
 *  unfinished rather than silently done. */
export const ROW_PENDING = 'processing';

/**
 * Every value meaning "no verdict yet". Both spellings map to the same `pending` verdict.
 *
 * Two of them, and not one, because the workflow distinguishes a row it has accepted from a row it
 * is working on, and that distinction is worth storing even though nothing downstream branches on
 * it: the vocabulary is the workflow's, and a value it can write is a value both readers here have
 * to already understand. A row stamped with a spelling this set does not know falls through to the
 * score and reads as *finished* — which is the one failure mode this file exists to prevent, so an
 * unfinished spelling must be added here and nowhere else.
 */
export const ROW_UNFINISHED_VALUES = [ROW_QUEUED, ROW_PENDING] as const;

const UNFINISHED = new Set<string>(ROW_UNFINISHED_VALUES);

/**
 * The value a workflow writes when it decides a row matched — and now the whole of the answer.
 *
 * This used to be advisory: the verdict came from the row's score against MATCH_THRESHOLD, and a
 * row stamped `match` at 0.3 still read "No match". There is no score any more, so the stamp *is*
 * the verdict, and the bar that produced it is the matcher's rather than ours. That trade is the
 * point of dropping the score — one authority instead of two — but it is worth naming: a matcher
 * that loosens its threshold now moves every count in this product, and nothing here will notice.
 */
export const ROW_MATCH = 'match';

/**
 * Every spelling meaning "decided, and it matched".
 *
 * Several, for the same reason `ROW_FAILED_VALUES` has several: the column has no CHECK
 * constraint and is written by a system that has never had to agree with us about vocabulary.
 * A matcher that writes `matched` where we expected `match` would otherwise have every one of
 * its hits fall through to `unmatched` — silently, and with the counts and badges agreeing
 * perfectly on the wrong answer.
 */
export const ROW_MATCHED_VALUES = [ROW_MATCH, 'matched'] as const;

const MATCHED = new Set<string>(ROW_MATCHED_VALUES);

/**
 * The value a workflow writes when it decides a row matched nobody.
 *
 * Not read by `rowVerdict` — anything decided that is not a match is already `unmatched` by the
 * fallthrough. It is kept because a workflow needs *some* way to say "looked at, found nobody"
 * that is distinguishable from "not looked at yet", and because it is what
 * `docs/EXTERNAL-MATCHER.md` promises a workflow it may write.
 */
export const ROW_UNMATCH = 'unmatch';

/**
 * The workflow gave up on this row.
 *
 * Several spellings because the workflow is a separate system that has never had to agree with
 * us about vocabulary, and an unconstrained column is one it can spell any way it likes.
 */
export const ROW_FAILED_VALUES = ['fail', 'failed', 'error', 'errored'] as const;

const FAILED = new Set<string>(ROW_FAILED_VALUES);

/**
 * The four things a row can be, as far as anything downstream is concerned.
 *
 * `unmatched` is not a value, it is a conclusion: the row is finished, it did not break, and it is
 * not a match. Which is also why an unrecognised status cannot be dropped or thrown on — a row
 * stamped *something* has been dealt with, and the only structurally meaningful claim the column
 * makes is `ROW_UNFINISHED_VALUES` ("not yet").
 */
export type RowVerdict = 'pending' | 'matched' | 'unmatched' | 'failed';

/**
 * The verdict for one row — entirely what the workflow stamped on it.
 *
 * There used to be a split of authority here: the workflow owned whether a row was *done*, and we
 * owned what counted as a *match*, deciding that ourselves from the row's score against
 * MATCH_THRESHOLD. The score is gone, so the split is gone with it. The matcher decides both.
 *
 * What that buys is that the badge on a row, the tabs above it and the number on Past runs all
 * read one column and cannot drift apart. What it costs is that "match" now means whatever the
 * matcher's own bar means, and we can no longer see, restate or re-judge it: raising the old
 * threshold silently re-graded every historical run, because nothing was stored. Now a run is
 * judged once, when it is written, and that judgement is permanent.
 *
 * Trimmed and lowercased because the value is written by another system: it can arrive as `Match`,
 * or `unmatch `, and a reader that only knew the exact lowercase spelling would call a finished row
 * pending — silently, and with total confidence.
 *
 * Order matters: unfinished and failed are checked before matched, so a row stamped with a
 * spelling in two sets reads as the more conservative one.
 *
 * A missing status (null/undefined) is `unmatched` — finished, and not a match. That is the honest
 * reading: every table that carries rows worth a verdict has the column, so the only way to arrive
 * here without one is a caller that did not select it, and a row nobody stamped `pending` is a row
 * nobody is still working on. It is also the safe direction to be wrong in — a stranger shown as
 * "No match" is a non-event, a stranger shown as a match is a bad introduction.
 */
export function rowVerdict(status: string | null | undefined): RowVerdict {
  const s = status?.trim().toLowerCase() ?? '';
  if (UNFINISHED.has(s)) return 'pending';
  if (FAILED.has(s)) return 'failed';
  return MATCHED.has(s) ? 'matched' : 'unmatched';
}
