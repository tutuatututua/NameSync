import { z } from 'zod';

/**
 * WHICH ROWS a run covers — the axis that was missing while every run was started by an import.
 *
 * A run has always had three settings: which companies (`selected_companies`), which rosters
 * (`sources`) and how to compare (`compare_by`). None of them can express "score these people
 * again", because all three narrow a population that was decided somewhere else — by the import
 * that opened the run. That was fine while an import was the only way to start one. It stopped
 * being fine the moment the Network page could start a run over data already on file: "re-compare
 * BlueBrick", "re-compare Alex's friends", "re-compare that file" are the three questions people
 * actually ask, and not one of them is a company list, a source list or a mode.
 *
 * So the scope is its own pair of columns, and it is a PAIR rather than a set of nullable columns
 * per kind for the reason `compare_by` is one column rather than two: a row must not be able to
 * exist half-configured. `filter_by` names the axis and `filter_value` carries the one value it
 * takes, and a reader who does not recognise the axis still knows there was one.
 *
 * ── IT IS ALSO THE WIRE CONTRACT ──
 *
 * Both keys travel to the external matcher (`docs/EXTERNAL-MATCHER.md`), as CSV columns and as
 * headers, and they are what the workflow SELECTS on: for `upload` it reads the rows it was handed,
 * and for the other three it selects them itself out of `friend` / `company_contact`. That is why
 * the vocabulary lives here rather than in the API — the value the database stores and the value
 * the workflow branches on have to be one string, spelled once.
 */

// ── The vocabulary ──────────────────────────────────────────────────────────

/**
 * · `upload`  — an import-driven run. The rows are the ones the import just handed over, and the
 *               scope value is the `upload.id` they were filed under. TODAY'S BEHAVIOUR, named:
 *               every run that existed before this axis was one of these, which is why it is in
 *               the list rather than being expressed as a null.
 * · `company` — every contact at one company, scored against the friends on file.
 * · `owner`   — every friend one person owns the relationship with (`friend.relationship_owner`).
 * · `file`    — every row of one past import (`upload.id`), whichever side it was.
 *
 * `file` is a specific IMPORT and not a source type ('facebook', 'linkedin'). The source axis
 * already exists and is `sources`; what this one adds is "that file, the one I uploaded on
 * Tuesday", which no combination of the others can name.
 */
export const FILTER_BY_VALUES = ['upload', 'company', 'owner', 'file'] as const;
export type FilterBy = (typeof FILTER_BY_VALUES)[number];
export const FilterBySchema = z.enum(FILTER_BY_VALUES);

/**
 * The three a USER can ask for.
 *
 * `upload` is excluded, and not as an oversight: it describes a run that an import opens for
 * itself, and the value it carries is an `upload.id` that exists only because rows were just
 * written. A caller asking for one over an import that already happened would be asking to re-send
 * rows, which is what `POST /:id/send-webhook` is for.
 */
export const REQUESTABLE_FILTER_BY = ['company', 'owner', 'file'] as const;
export type RequestableFilterBy = (typeof REQUESTABLE_FILTER_BY)[number];
export const RequestableFilterBySchema = z.enum(REQUESTABLE_FILTER_BY);

/**
 * A run's scope as ONE value.
 *
 * The database stores it as two columns because SQL has no pair type, and the wire sends it as two
 * keys for the same reason. Everything in between holds it as this, so "set the axis and forget the
 * value" is not a state any layer can reach — the API model, the webhook sender and the compare
 * dialog all took a local copy of this shape before it was written down here, which is three places
 * one of them could have drifted.
 */
export interface RunScope {
  filterBy: FilterBy;
  filterValue: string;
}

/**
 * The same pair, narrowed to what a CALLER may ask for.
 *
 * `upload` is not in it, so a scoped run cannot be requested for an import that already happened —
 * the type says what `RequestableFilterBySchema` enforces, rather than leaving the dialog to find
 * out from a 400.
 */
export interface RequestedScope {
  filterBy: RequestableFilterBy;
  filterValue: string;
}

/**
 * ── BOTH KEYS, OR NEITHER ──
 *
 * `CompareByCompanyBodySchema` refuses a half-scope, and the rule is stated here because it is a
 * fact about the pair rather than about that one endpoint. Either half alone is a run nobody can
 * describe: `filter_by='owner'` with no name selects every friend and calls itself scoped, and a
 * `filter_value` with no axis is a string with no question attached.
 *
 * Omitting both is the legacy shape and stays supported — a whole-table or company-list run, stored
 * with a NULL scope, which is what every caller written before this axis existed sends.
 */

// ── How a scope reads on screen ─────────────────────────────────────────────

/** The axis, as a word for a chip. Sentence case — it appears inside a phrase, not as a control. */
export const FILTER_BY_LABEL: Record<FilterBy, string> = {
  upload: 'Import',
  company: 'Company',
  owner: 'Owner',
  file: 'File',
};

/**
 * "Company · BlueBrick" — one spelling, because the chip on a run, the line in the compare dialog
 * and the sentence in a toast all name the same scope and a reader moving between them must not
 * have to work out that they mean the same run.
 *
 * Null in, null out: a run with no stored scope is a legacy run, and inventing "All rows" for it
 * would claim a choice nobody made. The badge renders nothing rather than a default — the opposite
 * of `SourcesBadge`, and deliberately, because "no scope" here really is the absence of an answer
 * rather than one of the answers.
 */
export const scopeLabel = (
  filterBy: string | null | undefined,
  filterValue: string | null | undefined
): string | null => {
  if (!filterBy) return null;
  const axis = (FILTER_BY_LABEL as Record<string, string | undefined>)[filterBy] ?? filterBy;
  return filterValue ? `${axis} · ${filterValue}` : axis;
};

/** The sentence a scope chip carries as a tooltip — what the run actually covered. */
export const scopeTooltip = (
  filterBy: string | null | undefined,
  filterValue: string | null | undefined
): string | undefined => {
  switch (filterBy) {
    case 'upload':
      return `Started by an import — the rows of upload ${filterValue ?? '?'}.`;
    case 'company':
      return `Every contact at ${filterValue}, scored against the friends on file.`;
    case 'owner':
      return `Every friend ${filterValue} owns the relationship with.`;
    case 'file':
      return `Every row of import ${filterValue}.`;
    default:
      return undefined;
  }
};
