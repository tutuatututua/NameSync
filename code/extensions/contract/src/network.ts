import { z } from 'zod';
import { PaginationQuerySchema } from './common';
import { CompareBySchema } from './compare-by';
import { ThresholdSchema } from './threshold';

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
 *
 * ── `?threshold=` — the bar the whole workspace is read at (2026-07-31) ──
 *
 * Every endpoint below takes one, and it is the same overlay `threshold.ts` documents for a single
 * run: an explicit, per-request "show me this as though the bar had been here", applied to stored
 * rows on the way out and never written down. Absent means the matcher's own verdicts, byte for
 * byte what these endpoints returned before the parameter existed.
 *
 * It moved HERE from the run page because it was answering the wrong question there. A bar tuned on
 * run 3 tuned run 3, and the numbers people actually act on — who reaches BANGKOK BANK, how many of
 * an owner's friends were placed — are pooled across every run on file and were stuck at whatever
 * each matcher decided. Tuning is now done once, against the pooled answer, which is the only place
 * the reader can see what loosening or tightening the bar costs them.
 *
 * The consequence, and the reason each endpoint's parameter is documented rather than assumed: the
 * bar re-grades ROWS, so it moves every count derived from them — matched friends, a company's
 * reach, an owner's roster split, who "knows" a contact. `confirmed` is NOT one of those. It is a
 * fact about the RUN that produced the row (did it compare whole names?), so a lead cannot be
 * promoted to confirmed by moving a slider — only by a stronger run.
 */

// ── Overview: one roster's connections across every company ──────────────────

/** A company the roster reaches, and how many distinct people reach it. */
export const CompanyConnectionSchema = z.object({
  company: z.string(),
  /** Distinct people (friends) in the roster with a match at this company. */
  connections: z.number(),
  /**
   * How many of those `connections` rest on a whole-name match — always ≤ `connections`, and the
   * rest are leads. Split out so "BANGKOK BANK · 12 connections" cannot keep reading as twelve
   * people you can ask for, when all twelve may be surname hits.
   */
  confirmed: z.number(),
});
export type CompanyConnection = z.infer<typeof CompanyConnectionSchema>;

/**
 * GET /api/network/overview — `uploader` scopes to one person's roster; omitted means everyone.
 * Matched case-insensitively against `friend.relationship_owner` — whose relationship a friend is,
 * not who imported them. (It was `comparison_result.upload_name` until 2026-07-30; see
 * `api/src/models/network.model.ts` for why an externally-written column stopped being the key.)
 */
export const NetworkOverviewQuerySchema = z.object({
  uploader: z.string().trim().min(1).optional(),
  /** Read every tally on this tab at a bar the reader picked; omitted = the matchers' own
   *  verdicts. See the file header. */
  threshold: ThresholdSchema.optional(),
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
  /**
   * How many of `friendsMatched` have a whole-name match — the rest are leads.
   *
   * A SUBSET, deliberately, not a narrowing of `friendsMatched`. Redefining "matched" as
   * confirmed-only would push leads into `friendsNoMatch`, which restates a match as a non-match
   * and breaks `friends − friendsMatched = friendsNoMatch` against what the page shows. The grade
   * goes *inside* the number instead, as the Matched tile's hint.
   */
  friendsConfirmed: z.number(),
  /** Every distinct company on file — the denominator for "no connection". */
  companiesOnFile: z.number(),
  /** Total distinct (person, company) matches — one person counted once per company they reach. */
  connections: z.number(),
  /** Companies the roster reaches ("companies known"), strongest first. `companiesKnown = connected.length`. */
  connected: z.array(CompanyConnectionSchema),
});
export type NetworkOverviewData = z.infer<typeof NetworkOverviewDataSchema>;

// ── How much of the stored evidence the bar can move ─────────────────────────

/**
 * GET /api/network/grading — what the threshold control has to work on.
 *
 * Its own endpoint rather than a field on the overview payload, because it is the one fact on this
 * workspace that is NOT about a roster: it describes the whole `comparison_result` table, and the
 * control that needs it sits above the tabs, outside any roster selection. Folding it into the
 * overview would have tied a page-level control to a tab's local state and re-fetched a constant
 * every time somebody switched rosters.
 *
 * It exists because `regradeVerdict` cannot re-grade a row with no score, which on a database fed
 * by an external workflow is most of them. Without this the slider looks broken: the reader drags
 * it from end to end, the headline moves by three, and nothing on screen explains that the other
 * 253 rows were never scored and keep their matcher's verdict at every bar.
 */
export const NetworkGradingDataSchema = z.object({
  /** Every stored result row. */
  results: z.number(),
  /**
   * How many of them carry a `similarity` — the rows a bar can actually re-grade.
   *
   * Rows, not friends: the row is the unit the bar grades, and a friend can hold several of which
   * only some were scored. Zero means the control can do nothing at all and should say so rather
   * than offer a handle that moves nothing.
   */
  scored: z.number(),
});
export type NetworkGradingData = z.infer<typeof NetworkGradingDataSchema>;

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
  /** Of those, how many rest on a whole-name match. `matched − confirmed` are leads. */
  confirmed: z.number(),
  /** The rest — friends with no connection yet. */
  noMatch: z.number(),
});
export type UploaderStats = z.infer<typeof UploaderStatsSchema>;

/**
 * GET /api/network/uploaders — every uploader with a friend list, strongest first.
 *
 * A querystring at all only since the network-wide bar existed; the endpoint took none before, and
 * with `threshold` omitted it still behaves as though it takes none.
 */
export const UploadersQuerySchema = z.object({
  threshold: ThresholdSchema.optional(),
});
export type UploadersQuery = z.infer<typeof UploadersQuerySchema>;

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
   * How close the match was, in [0, 1] — the score of the STRONGEST-MODE run that matched this
   * pairing, and the best score among the runs that share that mode.
   *
   * It used to be `max(similarity)` across every run on file, and that was a category error: a
   * surname run and a full-name run measure different things, so the maximum of the two could carry
   * a surname run's number onto a pairing a full-name run confirmed — the score and the claim
   * beside it coming from two different runs. The fold is now "strongest mode first, then best
   * score", which is the same argument the near-miss query already makes about composing a person
   * who does not exist.
   *
   * Read it together with `mode`: the number is only meaningful as a measurement OF something, and
   * `mode` is what it measured. On a partial mode the UI states the unit (`surname 94%`).
   *
   * Null when no run recorded one — an external matcher that reported only a verdict. It never
   * decides whether this is a match; being in this list is what says that.
   */
  similarity: z.number().nullable(),
  /**
   * The mode of the run this row's evidence came from — the same run that produced `similarity`.
   *
   * Never null: resolved server-side through `parseCompareBy`, so a run predating the column or
   * carrying an unrecognised value arrives as `DEFAULT_COMPARE_BY` rather than as an absence the
   * client would have to invent a rule for. The client derives the tier from it with
   * `matchStrength`, so the grading has exactly one definition and the server never ships a
   * pre-chewed label the client could disagree with.
   */
  mode: CompareBySchema,
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
  /**
   * The mode of the run that produced the near miss — what question was being asked when this
   * friend was turned down.
   *
   * It matters more here than anywhere else on the page: "closest was somchai jaidee at 61%" reads
   * as a weak resemblance between two whole names, when under `en_surname` it means two surnames
   * scored 61% and the given names were never looked at. Same server-side resolution as
   * `MatchedPerson.mode`, so it is never null.
   */
  mode: CompareBySchema,
});
export type NoMatchPerson = z.infer<typeof NoMatchPersonSchema>;

/**
 * A company this roster reaches, and the matched people under it.
 *
 * Leads stay in `people` rather than moving to `noMatchPeople` or into a third group of their own.
 * Moving them would restate a match as a non-match and decouple this section from the tile that
 * links to it; a third group would put three sections under two tiles, and the invariant this app
 * holds everywhere is that the thing you press and the number on it answer the same question. They
 * are sorted after the confirmed matches within their company instead, and `confirmed` lets the
 * group header state the split.
 */
export const CompanyMatchGroupSchema = z.object({
  company: z.string(),
  people: z.array(MatchedPersonSchema),
  /** How many of `people` are confirmed; `people.length − confirmed` are leads. */
  confirmed: z.number(),
});
export type CompanyMatchGroup = z.infer<typeof CompanyMatchGroupSchema>;

/**
 * GET /api/network/uploader?name= — one uploader's full breakdown: the counts, plus the actual
 * names split into matched (grouped by the company they landed at) and no-match. Scoped to one
 * roster, so the lists come back whole rather than paged.
 */
export const UploaderDetailQuerySchema = z.object({
  name: z.string().trim().min(1),
  /**
   * The bar this roster is read at — carried here from the Network page, not set on this one.
   *
   * Without it the drill-down would contradict the tab that linked to it: a roster listed as
   * "12 matched" at 0.9 would open on the 40 its matchers had accepted. The bar moves BOTH lists,
   * which is the point — a friend who drops out of `matchedByCompany` reappears in `noMatchPeople`,
   * carrying the near miss that is now the score which failed to clear it.
   */
  threshold: ThresholdSchema.optional(),
});
export type UploaderDetailQuery = z.infer<typeof UploaderDetailQuerySchema>;

export const UploaderDetailDataSchema = z.object({
  /** The roster this payload describes, echoed back as asked. */
  uploader: z.string(),
  friends: z.number(),
  /**
   * Everyone who imported part of this roster, alphabetically — usually just the owner themself.
   *
   * A roster is not necessarily one file by one person: an owner's friends can arrive across
   * several imports, and any of them may have been performed by somebody else. This answers "where
   * did these 50 friends come from", which is the question a roster that looks wrong provokes, and
   * it is the only place in the app that answers it for an OWNER rather than for an upload.
   *
   * Empty is possible and means no import on file records who performed it — not that nobody did.
   */
  importedBy: z.array(z.string()),
  matched: z.number(),
  /** Of `matched`, how many rest on a whole-name match — `matched − confirmed` are leads. */
  confirmed: z.number(),
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
  /**
   * The bar every connection count on the row is taken at.
   *
   * It does NOT select which contacts come back — the search is over `company_contact`, and a
   * person is on file at a company whatever any matcher decided about them. What it moves is what
   * the row says about the NETWORK: how many people reach the company, and who knows this contact.
   * A contact nobody reaches at 0.95 is still a contact, listed with an empty "known by".
   */
  threshold: ThresholdSchema.optional(),
}).refine((b) => !!b.q || !!b.company, {
  message: 'Provide a search term or a company',
});
export type NameSearchQuery = z.infer<typeof NameSearchQuerySchema>;

/**
 * One uploader who knows a contact, how close the match that says so was, and what it compared.
 *
 * A name alone used to be the whole answer, and it hid the difference between "Alex's friend IS
 * this person" and "Alex has a friend whose name looks a bit like theirs" — two claims that lead to
 * very different emails. The score closed half that gap; `mode` closes the other half, which the
 * score alone could not: `Alex · 94%` reads identically whether that 94% is two whole names or two
 * surnames, and a surname-only match presented as "Alex knows this person" is one step from an
 * introduction requested in a colleague's name.
 */
export const ConnectedUploaderSchema = z.object({
  /**
   * The RELATIONSHIP OWNER — whose friend this is, and the roster page's key.
   *
   * Read from `friend.relationship_owner`, not from `comparison_result.upload_name`, since
   * 2026-07-30. The two are meant to be the same value and the second is written by an external
   * workflow, so when they disagree this is the one that came from a row the app can point at.
   * See `NetworkModel`'s header for what the disagreement actually cost.
   */
  name: z.string(),
  /**
   * THE FRIEND'S NAME AS THIS RUN COMPARED IT — the other half of the pairing.
   *
   * The result row's spelling in the language `mode` names — taken from the SAME row `similarity`
   * and `mode` come from, so the three describe one comparison rather than three. (It was a column
   * of its own, `comparison_result.friend_name`, until 2026-08-03c.) Without it the claim is
   * unfalsifiable by
   * the person reading it: "tua · surname 94%" on a contact named `sunisa phongphaew` says a run
   * scored 94% and says nothing about *what tua's friend is called*, which is the one fact that
   * makes the number checkable — a lead resting on `phongphaew` reads very differently once you can
   * see the friend was `nattapong phongphaew`.
   *
   * It is the friend as the RUN saw them (frozen text on the result row), not the friend row's
   * current name: this number was produced against that string, and showing a renamed friend beside
   * an old score would attach the evidence to a name that never earned it.
   *
   * Null when the run recorded no friend name — an external workflow that posted a verdict against
   * a contact and nothing about its own side. The connection still stands; only the pairing cannot
   * be spelled out, and the UI says so rather than inventing a name.
   */
  friend: z.string().nullable(),
  /**
   * THE SAME FRIEND'S OTHER SPELLING, as `friend` holds it TODAY — not evidence, and not from the
   * result row.
   *
   * `friend` above is frozen text: the string this run actually scored. This is the person's other
   * name as currently on file, and the distinction is the whole reason both exist. Read off the
   * `friend` row rather than `comparison_result.friend_name_en` / `_th`, because those two are
   * written only by the INTERNAL matcher and are null on every row an external workflow produced.
   *
   * It exists because a run can record a spelling in one language while we hold the other, which is
   * not hypothetical: on this database a `th_name` run recorded Latin names for half its rows (its
   * workflow ignored `compare_by`), so the Thai spelling — the one a Thai reader actually recognises
   * — appeared nowhere on the connection. The pairing still leads with what was scored; this rides
   * beside it, muted, as identity rather than as proof.
   *
   * Null when the friend row is gone (a rolled-back import), when we hold only one spelling, or when
   * the recorded name matches neither column because the friend was renamed after the run.
   */
  friendAlt: z.string().nullable(),
  /**
   * Who PERFORMED the import that brought this friend in — usually the same person as `name`, and
   * worth stating precisely because it is not always.
   *
   * An owner is per friend row so that an assistant can import a salesperson's contacts; the moment
   * that is possible, "win knows this person" leaves open who typed the roster in, and therefore
   * who to ask when it looks wrong. Where connections are rendered as CHIPS (Search) it rides in
   * the tooltip: the name you act on is the owner, chips wrap several to a row, and a second name
   * on the front of one pushes the first out of the glance. Where a connection gets a row of its
   * own (the company page) it is stated outright beside the owner, because there the two names have
   * room to be labelled and the reader is being shown provenance deliberately rather than in
   * passing.
   *
   * Null when no import records one, or when the friend row is gone (a rolled-back import) and the
   * owner survives only as text on the result row. It is NEVER back-filled from `upload_name` — a
   * column that is contractually the owner cannot be read as the importer, which is precisely the
   * conflation that broke this page.
   */
  uploadedBy: z.string().nullable(),
  /**
   * In [0, 1], or null when no run scored the pairing. Never the verdict; presence here is that.
   *
   * The score of the strongest-mode run for this (uploader, contact) pair, NOT `max` across every
   * run — see `MatchedPerson.similarity` for why the maximum of two modes is a number that belongs
   * to neither claim.
   */
  similarity: z.number().nullable(),
  /** The mode `similarity` was measured under. Never null; see `MatchedPerson.mode`. */
  mode: CompareBySchema,
  /**
   * This pairing was confirmed by a Thai full-name run AND an English full-name run.
   *
   * Two independent spellings agreeing is markedly stronger evidence than either run alone — close
   * to conclusive. It does NOT earn a third tier, because corroborated and confirmed lead to the
   * same action (ask for the intro) and that is the whole test for whether a tier should exist. It
   * earns a line in the tooltip, which costs nothing.
   *
   * The mirror case — matched in one language, poorly scored in the other — is deliberately not
   * reported. Each run keeps only each friend's single best contact, so two runs often will not
   * have scored the same pairing at all; a disagreement signal would fire inconsistently and mean
   * different things depending on what else happened to be in the pool.
   */
  corroborated: z.boolean(),
});
export type ConnectedUploader = z.infer<typeof ConnectedUploaderSchema>;

/**
 * One uploader who reaches a contact's COMPANY, and whether any of that reach is confirmed.
 *
 * A bare name until 2026-07-27, and the reason given was sound and still is: company reach is not
 * one pairing, so there is no single score to put on it. Strength does not inherit that problem —
 * it is ordinal with a defined winner, so "does this person have a whole-name match at this company
 * anywhere" folds cleanly where an average or a maximum of scores would have been meaningless.
 * Hence a boolean here and no `similarity`, rather than either both or neither.
 */
export const CompanyUploaderSchema = z.object({
  /** The relationship owner — same sourcing as `ConnectedUploader.name`. */
  name: z.string(),
  /** Who imported their roster; see `ConnectedUploader.uploadedBy`. One name, not a list — the
   *  roster page's `importedBy` is where a multi-importer roster is spelled out in full. */
  uploadedBy: z.string().nullable(),
  /** True when at least one of this uploader's matches at the company is a whole-name match. */
  confirmed: z.boolean(),
});
export type CompanyUploader = z.infer<typeof CompanyUploaderSchema>;

export const NameSearchRowSchema = z.object({
  id: z.string(),
  company_name: z.string().nullable(),
  person_name_en: z.string().nullable(),
  person_name_th: z.string().nullable(),
  /** Distinct people in the network with a match somewhere at this contact's company. */
  companyConnections: z.number(),
  /** Of those, how many reach it on a whole-name match. The rest are leads. */
  companyConnectionsConfirmed: z.number(),
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
  companyUploaders: z.array(CompanyUploaderSchema),
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
