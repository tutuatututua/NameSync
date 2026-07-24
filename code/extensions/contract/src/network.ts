import { z } from 'zod';
import { PaginationQuerySchema } from './common';

/**
 * The Network workspace — three questions asked of the same stored data.
 *
 * Everything here READS what a comparison already produced (`comparison_result`), rather than
 * running the matcher again: the Overview and Search views are a second lens on runs the user
 * has already made, never a fresh match. New matches still come from `POST /comparisons/compare`.
 *
 * The one write is renaming a company contact — which is master data, not a run, so it is the
 * only thing here that can change what a *future* comparison finds. Past runs stay frozen: a
 * `comparison_result` row stores names as text with no FK back, so a rename does not (and must
 * not) rewrite history.
 */

// ── Overview: one roster's connections across every company ──────────────────

/** A company the roster reaches, and how many distinct people reach it. */
export const CompanyConnectionSchema = z.object({
  company: z.string(),
  /** Distinct people (friends) in the roster with a match at this company. */
  connections: z.number(),
});
export type CompanyConnection = z.infer<typeof CompanyConnectionSchema>;

/**
 * GET /api/network/overview — `uploader` scopes to one person's roster; omitted means everyone.
 * Uploaders are matched case-insensitively against `comparison_result.upload_name`.
 */
export const NetworkOverviewQuerySchema = z.object({
  uploader: z.string().trim().min(1).optional(),
});
export type NetworkOverviewQuery = z.infer<typeof NetworkOverviewQuerySchema>;

export const NetworkOverviewDataSchema = z.object({
  /** Every uploader who has uploaded friends — the roster picker's options. */
  uploaders: z.array(z.string()),
  /** The roster this payload describes, or null for "everyone". */
  uploader: z.string().nullable(),
  /** How many friends this roster uploaded — the true roster size, from the friend list itself
   *  (not from results), so it is right even before any comparison has run. */
  friends: z.number(),
  /** How many of those friends matched someone at any company. `friendsNoMatch = friends −
   *  friendsMatched`. Counted by distinct name, so it is exact for a single uploader (names are
   *  unique within a roster) and a close approximation for "everyone". */
  friendsMatched: z.number(),
  /** Every distinct company on file — the denominator for "no connection". */
  companiesOnFile: z.number(),
  /** Total distinct (person, company) matches — one person counted once per company they reach. */
  connections: z.number(),
  /** Companies the roster reaches ("companies known"), strongest first. `companiesKnown = connected.length`. */
  connected: z.array(CompanyConnectionSchema),
});
export type NetworkOverviewData = z.infer<typeof NetworkOverviewDataSchema>;

// ── Uploaders: per-roster match tallies, and one roster's matched/no-match names ──

/**
 * One uploader's roster and how it landed — a row of the Uploaders tab.
 * `noMatch = friends − matched`, so the three always reconcile.
 */
export const UploaderStatsSchema = z.object({
  uploader: z.string(),
  /** Friends this uploader contributed (the roster size). */
  friends: z.number(),
  /** How many of them matched someone at any company. */
  matched: z.number(),
  /** The rest — friends with no connection yet. */
  noMatch: z.number(),
});
export type UploaderStats = z.infer<typeof UploaderStatsSchema>;

/** GET /api/network/uploaders — every uploader with a friend list, strongest first. */
export const UploadersDataSchema = z.object({
  uploaders: z.array(UploaderStatsSchema),
});
export type UploadersData = z.infer<typeof UploadersDataSchema>;

/**
 * One matched person under a company: the friend as they were uploaded, plus the matched contact's
 * English and Thai names.
 *
 * A friend list carries a single name each (`friend`), so `en`/`th` come from the *contact* the
 * friend matched — the same person, as the company has them on file. That is where an English name
 * for the match exists at all, and it is the actionable identity ("your friend is the director John
 * Smith"), so it rides alongside the uploaded name rather than replacing it.
 */
export const MatchedPersonSchema = z.object({
  /** The friend's name as uploaded (their social name), cleaned + lower-cased. */
  friend: z.string(),
  /** The matched contact's English name, or null if the contact has only a Thai one. */
  en: z.string().nullable(),
  /** The matched contact's Thai name, or null. */
  th: z.string().nullable(),
  /**
   * How close the match was, in [0, 1] — the best score any run recorded for this pairing.
   *
   * The strongest of them rather than the latest, because these rows are folded over every run on
   * file: the same friend may have been scored against the same contact several times, and the
   * question this page answers ("how sure are we they're the same person") is settled by the best
   * evidence, not the most recent.
   *
   * Null when no run recorded one — an external matcher that reported only a verdict. It never
   * decides whether this is a match; being in this list is what says that.
   */
  similarity: z.number().nullable(),
});
export type MatchedPerson = z.infer<typeof MatchedPersonSchema>;

/**
 * A friend with no connection on file — and whatever a run recorded while deciding that.
 *
 * The friend themself is a name and nothing else: `friend` stores one column, so there is no Thai
 * spelling and no employer to report about *them*. What there can be is the contact the matcher
 * came closest to and rejected — the internal matcher keeps every friend's best candidate whether
 * it cleared the bar or not, so a no-match row already carries that contact's English name, Thai
 * name, employer and score. `th` and `company` are that contact's, never the friend's, which is
 * why they are named for the near miss rather than mirroring `MatchedPerson`'s fields.
 *
 * All four are null on a friend no run ever scored (never compared, or an external matcher that
 * posts only its matches). The friend still belongs in the list — being unplaced is the fact this
 * list is about; the near miss is context, not the entry.
 */
export const NoMatchPersonSchema = z.object({
  /** The friend's name as uploaded (their social name), cleaned + lower-cased. */
  friend: z.string(),
  /** The closest considered contact's English name, or null. */
  en: z.string().nullable(),
  /** The closest considered contact's Thai name, or null. */
  th: z.string().nullable(),
  /** Where that contact works, or null. NOT where the friend works — nothing knows that. */
  company: z.string().nullable(),
  /** How close that near miss got, in [0, 1], or null when the run recorded no score. Always
   *  below whatever bar the matcher applied: a score that cleared it would be a match. */
  similarity: z.number().nullable(),
});
export type NoMatchPerson = z.infer<typeof NoMatchPersonSchema>;

/** A company this roster reaches, and the matched people under it. */
export const CompanyMatchGroupSchema = z.object({
  company: z.string(),
  people: z.array(MatchedPersonSchema),
});
export type CompanyMatchGroup = z.infer<typeof CompanyMatchGroupSchema>;

/**
 * GET /api/network/uploader?name= — one uploader's full breakdown: the counts, plus the actual
 * names split into matched (grouped by the company they landed at) and no-match. Scoped to one
 * roster, so the lists come back whole rather than paged.
 */
export const UploaderDetailQuerySchema = z.object({
  name: z.string().trim().min(1),
});
export type UploaderDetailQuery = z.infer<typeof UploaderDetailQuerySchema>;

export const UploaderDetailDataSchema = z.object({
  /** The roster this payload describes, echoed back as asked. */
  uploader: z.string(),
  friends: z.number(),
  matched: z.number(),
  noMatch: z.number(),
  /** Matches grouped by company — one section per company the roster reaches, strongest first. */
  matchedByCompany: z.array(CompanyMatchGroupSchema),
  /** Friends with no connection — the names to chase next, each with the near miss a run recorded
   *  for them, where one exists. */
  noMatchPeople: z.array(NoMatchPersonSchema),
});
export type UploaderDetailData = z.infer<typeof UploaderDetailDataSchema>;

// ── Search: find a person, see their company and its connections ─────────────

/**
 * GET /api/network/search — two ways in, exactly one required:
 *   · `q`       — free text, matched against a person's name or their company (case-insensitive).
 *   · `company` — an EXACT company name; returns everyone at that company. Powers the company
 *                 popup opened from the Overview, where the company is known precisely.
 */
export const NameSearchQuerySchema = PaginationQuerySchema.extend({
  q: z.string().trim().min(1).optional(),
  company: z.string().trim().min(1).optional(),
}).refine((b) => !!b.q || !!b.company, {
  message: 'Provide a search term or a company',
});
export type NameSearchQuery = z.infer<typeof NameSearchQuerySchema>;

/**
 * One uploader who knows a contact, and how close the match that says so was.
 *
 * A name alone used to be the whole answer, and it hid the difference between "Alex's friend IS
 * this person" and "Alex has a friend whose name looks a bit like theirs" — two claims that lead to
 * very different emails. The score is per (uploader, contact) pair and is the best any run recorded
 * for it, for the same reason `MatchedPerson.similarity` is.
 */
export const ConnectedUploaderSchema = z.object({
  /** The uploader, as `comparison_result.upload_name` spells them — also the roster page's key. */
  name: z.string(),
  /** In [0, 1], or null when no run scored the pairing. Never the verdict; presence here is that. */
  similarity: z.number().nullable(),
});
export type ConnectedUploader = z.infer<typeof ConnectedUploaderSchema>;

export const NameSearchRowSchema = z.object({
  id: z.string(),
  company_name: z.string().nullable(),
  person_name_en: z.string().nullable(),
  person_name_th: z.string().nullable(),
  /** Distinct people in the network with a match somewhere at this contact's company. */
  companyConnections: z.number(),
  /**
   * The uploaders whose friend matched THIS contact — who in the network actually knows them, and
   * how close each one's match was. Empty means nobody does. Objects rather than bare names because
   * a contact can be known by several people at once and not equally well; see ConnectedUploader.
   */
  connectedUploaders: z.array(ConnectedUploaderSchema),
  /**
   * The uploaders who reach this contact's COMPANY at all — i.e. who has a connection to *someone*
   * there, not necessarily this person. A superset of `connectedUploaders`; this is the "who can
   * get me into this company" answer.
   */
  companyUploaders: z.array(z.string()),
});
export type NameSearchRow = z.infer<typeof NameSearchRowSchema>;

// ── Edit a contact's name (a company person left, or a director was renamed) ──

/**
 * PATCH /api/comparisons/company-data/:uuid — change a company contact's name(s) or employer.
 *
 * At least one field, and each is optional so the caller changes only what moved. Person names
 * are cleaned server-side exactly as an import cleans them (lower-cased, honorifics stripped),
 * because the stored name is the matcher's join key — a hand-typed "Somchai Jaidee" that skipped
 * the cleaner would silently stop matching the imported "somchai jaidee".
 */
export const RenameContactBodySchema = z
  .object({
    /** Empty string clears this name (allowed only while the other name survives). */
    person_name_en: z.string().trim().optional(),
    person_name_th: z.string().trim().optional(),
    /** A company can't be blank, so unlike the person names this can't be cleared. */
    company_name: z.string().trim().min(1, 'A company name is required').optional(),
  })
  .refine(
    (b) =>
      b.person_name_en !== undefined || b.person_name_th !== undefined || b.company_name !== undefined,
    { message: 'Nothing to change — provide a name or company' }
  );
export type RenameContactBody = z.infer<typeof RenameContactBodySchema>;

/** The contact after an edit, names as they were actually stored (cleaned). */
export const ContactRowSchema = z.object({
  id: z.string(),
  company_name: z.string().nullable(),
  person_name_en: z.string().nullable(),
  person_name_th: z.string().nullable(),
});
export type ContactRow = z.infer<typeof ContactRowSchema>;
