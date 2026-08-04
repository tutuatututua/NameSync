import { z } from 'zod';

/**
 * WHICH FRIENDS a run compared — the third axis, beside `compare_by`'s language and name-part.
 *
 * `compare_by` says how much of a name to score and in which language. It says nothing about
 * *whose* names, and until this existed the answer was "everybody's": `FriendModel.findAllForMatching`
 * had no WHERE clause, so a run pointed at three companies scored every friend on file against them
 * — Facebook exports, LinkedIn exports and business cards alike, pooled into one verdict.
 *
 * That is the right default and the wrong only option. The sources are not interchangeable evidence:
 * a LinkedIn connection is a professional tie the owner can act on, a Facebook friend may be a
 * cousin, and a business card is a person met once. Pooling them makes "Alex knows someone at PTT"
 * true in a way that does not survive contact with the introduction request.
 *
 * ── NULL MEANS EVERY SOURCE ──
 *
 * Not "unknown", and not "none". It is the same convention `comparison.selected_companies` uses one
 * column over, and it exists so the common run — compare against all my friends — stores nothing
 * and needs no migration when somebody adds a fourth source next month.
 *
 * The dangerous reading is the other one. `sources = []` would mean "no friends are in this run",
 * which is not a run anybody wants and which would silently return zero matches rather than an
 * error. `normalizeSources` collapses empty to null at the boundary so the two shapes cannot both
 * reach the database, and no reader should ever `?? []` this value back into existence.
 *
 * ── THE VOCABULARY IS OPEN, SO THIS IS NOT AN ENUM ──
 *
 * `upload_source` seeds 'facebook' | 'linkedin' | 'business card' and any user can add a fourth
 * without a deploy; the Database console can write a fifth straight into `friend.source`. A
 * `z.enum` here would 400 a run naming a source that is plainly on rows the user can see. So the
 * values are free text, folded, and validated only for shape.
 *
 * Folded because that is how they are stored (`CreateUploadSourceBodySchema` lower-cases on the way
 * in) and how they are matched (`lower(source)`, with the index to match). A run naming 'Facebook'
 * and a friend row holding 'facebook' are the same run and the same friend.
 */

/** Longest a single source value can be — `friend.source` and `upload_source.value` are both
 *  varchar(100), so anything longer could never match a stored row anyway. */
const MAX_SOURCE_LENGTH = 100;

/**
 * The canonical form of a source list: folded, trimmed, de-duplicated, sorted, empty → null.
 *
 * SORTED IS LOAD-BEARING and not cosmetic. The duplicate-run check compares two lists for equality,
 * and ['facebook','linkedin'] must equal ['linkedin','facebook'] — the user ticked the same two
 * boxes. Sorting here means that comparison is a string compare rather than a set operation every
 * caller has to remember to write, and it means the stored array reads the same way every time it
 * is rendered.
 */
export function normalizeSources(input: readonly string[] | null | undefined): string[] | null {
  if (!input) return null;
  const seen = new Set<string>();
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const v = raw.trim().toLowerCase().slice(0, MAX_SOURCE_LENGTH);
    if (v) seen.add(v);
  }
  return seen.size ? [...seen].sort() : null;
}

/**
 * A source list on the wire.
 *
 * Nullable AND optional AND empty-tolerant, all three collapsing to the same null, because this
 * field is being added to endpoints that already have callers. Anything an existing caller sends
 * (which is nothing) must keep meaning what it has always meant: compare against every friend.
 */
export const CompareSourcesSchema = z
  .array(z.string().trim().min(1).max(MAX_SOURCE_LENGTH))
  .nullish()
  .transform((v) => normalizeSources(v));

/**
 * A stored `comparison.sources` as a list — the read-side twin of the schema above.
 *
 * Applied on the way OUT of the database, where the only callers are renderers, so it is lenient by
 * the same reasoning `parseCompareBy` is: a row written around the app (the Database console writes
 * this column too) holding something odd is still a row worth showing.
 */
export const parseSources = (value: unknown): string[] | null =>
  Array.isArray(value) ? normalizeSources(value as string[]) : null;

/**
 * Do two runs cover the same friends?
 *
 * Both null is "both compared everyone" and is equality, which is the case the duplicate warning
 * exists for — two default runs against the same companies in the same mode really are the same
 * run. Relies on `normalizeSources` having sorted both; call it on anything that has not been
 * through the boundary.
 */
export function sourcesEqual(a: string[] | null, b: string[] | null): boolean {
  if (a === null || b === null) return a === null && b === null;
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Is this friend's source in the run? A null list is every source, so everything is in it. */
export const sourceInRun = (source: string | null | undefined, sources: string[] | null): boolean =>
  sources === null || (!!source && sources.includes(source.trim().toLowerCase()));

// ── How it reads on screen ──────────────────────────────────────────────────

/**
 * What the app calls "compare against everything". Used as the picker's resting state and as the
 * chip on a run that named no source, so the two cannot drift into saying different things about
 * the same NULL.
 */
export const ALL_SOURCES_LABEL = 'All sources';

/**
 * Title-cased for display, the same rule `UploadSourceModel.create` applies when it stores a label.
 *
 * Only a fallback: prefer the `label` the `upload_source` row carries, which is what a user typed
 * and may be capitalised in ways this cannot guess ('LinkedIn' has an inner capital, and folding
 * plus title-casing gives 'Linkedin'). `SOURCE_LABEL_OVERRIDES` covers the seeded three; anything
 * else falls through to the generic rule and is corrected by the real label when one is on hand.
 */
const SOURCE_LABEL_OVERRIDES: Record<string, string> = {
  facebook: 'Facebook',
  linkedin: 'LinkedIn',
  'business card': 'Business card',
};

export const sourceLabel = (value: string): string =>
  SOURCE_LABEL_OVERRIDES[value] ?? value.charAt(0).toUpperCase() + value.slice(1);

/**
 * The chip that sits on a run: "All sources", "LinkedIn", "Facebook + LinkedIn", "3 sources".
 *
 * Names them while they fit and counts them once they do not, rather than truncating with an
 * ellipsis. A chip reading "Facebook, LinkedIn, Busine…" tells the reader less than "3 sources"
 * does and takes more room to do it; the full list belongs in the tooltip, which is where
 * `sourcesTooltip` puts it.
 *
 * `labels` is the `upload_source` list when the caller has it, so the chip shows what the picker
 * shows. Optional throughout — every surface that renders a run has the run, and only some of them
 * have the pick-list.
 */
export function sourcesLabel(
  sources: string[] | null,
  labels?: ReadonlyMap<string, string>
): string {
  if (!sources || sources.length === 0) return ALL_SOURCES_LABEL;
  const name = (v: string) => labels?.get(v) ?? sourceLabel(v);
  if (sources.length === 1) return name(sources[0]);
  if (sources.length === 2) return `${name(sources[0])} + ${name(sources[1])}`;
  return `${sources.length} sources`;
}

/** The full list, for the title attribute behind a counted chip. Null → the "everything" sentence,
 *  because a bare "All sources" chip is the one a reader is most likely to want explained. */
export function sourcesTooltip(
  sources: string[] | null,
  labels?: ReadonlyMap<string, string>
): string {
  if (!sources || sources.length === 0) return 'Every friend on file, whatever they were imported from.';
  return sources.map((v) => labels?.get(v) ?? sourceLabel(v)).join(', ');
}
