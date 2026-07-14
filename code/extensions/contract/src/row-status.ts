/**
 * What the external workflow stamps on a single uploaded row, and how both sides read it.
 *
 * Shared for the same reason `MATCH_THRESHOLD` is: the API tallies these into the counts above
 * the table and the UI renders them into the badges inside it, and if the two disagreed about
 * what `errored` means you would get a header reading "3 no match" over a table showing three
 * rows marked Failed. One vocabulary, imported twice.
 *
 * The column it describes (`friend.status` / `company_contact.status`) has deliberately no CHECK
 * constraint — see docs/EXTERNAL-MATCHER.md. An unexpected value must be *storable*, so both
 * readers here have to cope with one rather than reject it.
 */

/** The only value that means "not finished". It is also the column's default, so a row is
 *  pending from the moment it is inserted and a crashed workflow leaves rows visibly unfinished
 *  rather than silently done. */
export const ROW_PENDING = 'processing';

/** The only value that counts as a match. */
export const ROW_MATCH = 'match';

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
 * `unmatched` is not a value, it is the absence of the other three: the workflow finished the
 * row and did not call it a match or an error. That is why an unrecognised status lands here
 * rather than being dropped or thrown on — a row that has been stamped *something* has been
 * dealt with, and the only structurally meaningful claim is `processing` ("not yet").
 */
export type RowVerdict = 'pending' | 'matched' | 'unmatched' | 'failed';

/**
 * Read the raw column into a verdict.
 *
 * Trimmed and lowercased because the value is written by another system: it can arrive as
 * `Match`, or `unmatch `, and a reader that only knew the exact lowercase spelling would call
 * a matched row unmatched — silently, and with total confidence.
 */
export function rowVerdict(status: string | null | undefined): RowVerdict {
  const s = status?.trim().toLowerCase() ?? '';
  if (s === ROW_PENDING) return 'pending';
  if (s === ROW_MATCH) return 'matched';
  if (FAILED.has(s)) return 'failed';
  return 'unmatched';
}
