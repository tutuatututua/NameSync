import { z } from 'zod';

/**
 * How a run compared two names — the mode, and the rules that make it mean something.
 *
 * Two independent axes carried in one value, because a run has exactly one of these and splitting
 * it across two columns would let a row exist that is half-configured:
 *
 *   · LANGUAGE — English or Thai.
 *   · TYPE     — full name, name (given), or surname (family).
 *
 * ── LANGUAGE picks a column on BOTH sides ──
 *
 * Until 2026-07-28 it picked a column on the contact's side and a FILTER on the friend's, and the
 * argument for the asymmetry was that it lived in the data rather than in the schema: a social
 * export carries a single `name` field, so a second column would have meant script-detecting the
 * one stored name and filing it under a label — inventing no information, leaving every
 * Latin-script friend with a "missing" Thai name that was never missing, and storing a derivable
 * predicate ("this name happens to be Thai") in a column, which is the `_clean`-twin mistake this
 * codebase already reversed once.
 *
 * THAT PREMISE WAS TRUE OF A FACEBOOK EXPORT AND FALSE IN GENERAL. A business card prints both
 * spellings, and `upload_source` seeds it as a first-class import type — so a second name was
 * arriving in the files and the parser was throwing it away, listing the column under "Ignored
 * (nothing maps to them)" on the way past. `friend` now has `friend_name_en` / `friend_name_th`,
 * symmetric with `company_contact`, and neither column is derived from the other: each is what some
 * file actually said. The old objection still holds against the thing it was aimed at — nothing
 * script-detects a stored name to invent a column — and the one place a script test remains is
 * routing an UNLABELLED cell at import (see `hasThai` and the 2026-07-28 migration), which decides
 * where a name is stored, not what it means.
 *
 * So the axis now picks a COLUMN on each side, and "under `th`, Thai names are matched with Thai
 * names and nothing else is in play" is literally what happens rather than an accurate-enough
 * summary of a column choice plus a filter.
 *
 * THE MODE DECIDES WHAT IS SCORED, NEVER WHAT IS STORED. A friend with no name in the run's
 * language is skipped at MATCH time (`MatcherService.run`) and is still on file, still counted in
 * the roster, and still available to a later run in the other language. The import gate drops a row
 * only when BOTH columns are null. Letting a per-run setting decide what persists would put the
 * most disposable choice in the app in charge of permanent data.
 *
 * The excluded rows must be rendered, not hidden. "This name was never in this run" is a different
 * claim from "scored, matched nobody", and collapsing the two turns a question that was never asked
 * into an answer. See `isScorable` and `runRowBucket`.
 *
 * ── There is no "either" ──
 *
 * There was, until 2026-07-27, and it was the default: score against both contact columns and keep
 * the better (`Math.max`), so a mixed-script file matched in one pass with nobody excluded. It is
 * gone by request, and the consequence is worth stating because it is not small — **every run now
 * excludes one language.** A friends file holding both scripts can no longer be matched in a single
 * run; it takes two, one per language, and each reports the other language's names as "Not
 * compared". That is the intended behaviour, not a gap: the mode is a deliberate narrowing, and the
 * results table is built to show what each run left out.
 *
 * ── TYPE is derived at read time and never stored ──
 *
 * Names are stored as one cleaned, lower-cased string with every middle token kept, because
 * `name-cleaner.service.ts` refuses to guess at a split it cannot undo: without a raw twin, a bad
 * split of "ณ อยุธยา" or "Maria del Carmen Garcia" destroys the name permanently.
 *
 * That argument does not carry over to here, and the difference is the whole reason this is
 * allowed. Splitting at read time costs a bad COMPARISON, not a lost NAME: the stored string is
 * untouched, nothing has to be kept in step with the stored name, and re-running the same data under
 * a better splitter simply works. Which is also why this lives in the contract rather than in the
 * API — the results view re-applies it to mark which part of a name was in play, and a second
 * implementation on the client is exactly the drift that would make that highlight lie.
 */

// ── The vocabulary ──────────────────────────────────────────────────────────

/** Which spelling of a company contact to score against, and which friends are in the run. */
export const COMPARE_LANGUAGES = ['en', 'th'] as const;
export type CompareLanguage = (typeof COMPARE_LANGUAGES)[number];

/**
 * The two axes as schemas, for payloads that report on ONE of them rather than on a whole mode.
 *
 * Built from the constants above rather than written out, so a seventh mode cannot add a language
 * here without adding it there. `CompareBySchema` below stays the schema for a run's actual
 * setting — these are for reading a run's mode apart, which only the audit breakdowns do.
 */
export const CompareLanguageSchema = z.enum(COMPARE_LANGUAGES);

/**
 * How much of each name to score.
 *
 * `name` and `surname` rather than `first` and `last`: the workflow receives this verbatim as
 * `compare_type`, and "first/last" describes a POSITION in a string while "name/surname" describes
 * the thing being compared. They coincide in English and in Thai — both put the given name first —
 * but the position wording invites a reader to apply it to a format where they don't.
 */
export const COMPARE_TYPES = ['full', 'name', 'surname'] as const;
export type CompareType = (typeof COMPARE_TYPES)[number];

/** See `CompareLanguageSchema`. */
export const CompareTypeSchema = z.enum(COMPARE_TYPES);

/**
 * `'<language>_<type>'`. Six values — the full matrix, with nothing held back.
 *
 * Thai + surname is the shakiest cell and was the obvious one to drop, but it is also the most
 * valuable: Thai surnames are near-unique by law, so a shared Thai surname is strong evidence of a
 * family relationship, where a shared English surname ("smith") is mostly noise. Excluding the cell
 * where "surname" carries the most signal, to avoid a multi-token edge case that
 * `namePartCandidates` already handles by scoring both readings, would be backwards.
 */
export const COMPARE_BY_VALUES = [
  'en_full',
  'en_name',
  'en_surname',
  'th_full',
  'th_name',
  'th_surname',
] as const;

export const CompareBySchema = z.enum(COMPARE_BY_VALUES);
export type CompareBy = z.infer<typeof CompareBySchema>;

/**
 * Whole names, English.
 *
 * A default rather than a neutral option — there is no neutral option any more. It is the one that
 * changes least for an existing caller: `en_full` is what the old `either_full` did for a
 * Latin-script friends list, which is the common export. A Thai-script list wants `th_*` chosen
 * explicitly, and the "Not compared" count on the results page is what says so if it wasn't.
 */
export const DEFAULT_COMPARE_BY: CompareBy = 'en_full';

/**
 * A stored `comparison.compare_by` as a mode.
 *
 * Null → the default. Every run the app writes carries an explicit value (see
 * `ComparisonModel.create`), so null only arises from a row written around the app — the Database
 * console — or from a run predating the column. An unrecognised string → also the default, and
 * deliberately not an error: this is read on the way OUT of the database, where the only callers
 * are renderers, and a run whose mode column holds a value we do not understand is still a run
 * whose rows are worth showing. The vocabulary is enforced on the way IN, at the route boundary,
 * where rejecting a bad value costs one request instead of a whole page.
 */
export function parseCompareBy(value: string | null | undefined): CompareBy {
  const v = value?.trim().toLowerCase() ?? '';
  return (COMPARE_BY_VALUES as readonly string[]).includes(v) ? (v as CompareBy) : DEFAULT_COMPARE_BY;
}

/** The two axes, split back out — and the shape the webhook sends them in. */
export function compareByAxes(mode: CompareBy): { language: CompareLanguage; type: CompareType } {
  const [language, type] = mode.split('_') as [CompareLanguage, CompareType];
  return { language, type };
}

/** Build a mode from its axes — the inverse of `compareByAxes`, for the two-control UI. */
export const toCompareBy = (language: CompareLanguage, type: CompareType): CompareBy =>
  `${language}_${type}` as CompareBy;

// ── How each axis reads on screen ───────────────────────────────────────────

/**
 * The labels — plain, because the behaviour is plain: pick English and English names are matched
 * with English names; pick Thai and Thai with Thai. See the header for why that reading is honest
 * rather than loose (the language choice filters the friend side as well as picking a column).
 */
export const LANGUAGE_LABEL: Record<CompareLanguage, string> = {
  en: 'English',
  th: 'Thai',
};

export const TYPE_LABEL: Record<CompareType, string> = {
  full: 'Full name',
  name: 'Name',
  surname: 'Surname',
};

/** For the chip that sits on a run: "Surname · Thai". */
export const compareByLabel = (mode: CompareBy): string => {
  const { language, type } = compareByAxes(mode);
  return `${TYPE_LABEL[type]} · ${LANGUAGE_LABEL[language]}`;
};

// ── Script detection ────────────────────────────────────────────────────────

/** Thai (U+0E00–U+0E7F). Names are the only thing this is asked about, so a single block is
 *  enough — there is no Thai-adjacent script a person's name here would arrive in. */
const THAI = /[฀-๿]/;
/** Latin letters, including the accented ones a transliterated name can carry. */
const LATIN = /[A-Za-zÀ-ɏ]/;

export const hasThai = (s: string | null | undefined): boolean => !!s && THAI.test(s);
export const hasLatin = (s: string | null | undefined): boolean => !!s && LATIN.test(s);

/**
 * Could this name have been scored at all under this mode?
 *
 * False is "not compared" — visually and countably distinct from "compared, no match", and keeping
 * those apart is the single most important thing this mode does to the results table. A Latin
 * friend held against a contact's Thai column scores ~0 against every candidate; badged as "No
 * match" that reads as a finding ("nobody at this company is called that"), when the truth is that
 * the question was never asked of this row.
 *
 * Every run now has rows this can exclude, where the old `either` mode had none. That is the cost
 * of dropping it, and the results table earns it back by counting and filtering them separately.
 *
 * ── THIS IS NOW THE FALLBACK, NOT THE RULE ──
 *
 * It used to carry a caveat: for a run driven by the EXTERNAL matcher this was our INFERENCE from
 * the text rather than a report of what the workflow did, since a workflow ignoring `compare_type`
 * / `compare_language` scored the row regardless. That caveat is retired for stored friends. Since
 * 2026-07-28 `friend` has a column per language, so "could this run have scored this row" is
 * answered exactly the way the contact side has always answered it — is the selected column
 * non-null — which is a checkable fact rather than a reading of the characters. The API asks it
 * that way (`scorableSql` in friend.model.ts), and the "Not compared" bucket becomes honest as a
 * direct result: the row is excluded because we hold no name in that language, not because its
 * characters looked like the wrong script.
 *
 * What remains for this function is the case with no stored row to consult — a bare name in hand,
 * from a preview or a caller holding text and nothing else. The script test is the best available
 * answer there, and it is the same rule the import uses to file an UNLABELLED name into one of the
 * two columns (see `hasThai` and the 2026-07-28 migration's backfill).
 *
 * The wording rule is unchanged wherever this surfaces: say "no Thai name on file for this friend"
 * (a fact about the data) and never "the matcher skipped this".
 */
export function isScorable(name: string | null | undefined, language: CompareLanguage): boolean {
  if (!name) return false;
  return language === 'th' ? hasThai(name) : hasLatin(name);
}

// ── How strong is the claim? ────────────────────────────────────────────────

/**
 * What a stored match ENTITLES THE READER TO DO.
 *
 * The Network page pools `comparison_result` across every run, and those runs no longer ask the
 * same question — a full-name run and a surname run write rows of the same shape carrying evidence
 * of very different strength. Rendered identically (which is what `KnownByBadge` did), a surname
 * hit reads as "Alex knows this person", and that is one step from an introduction requested in a
 * colleague's name on the strength of a shared "smith".
 *
 * ── Two tiers, not three ──
 *
 * The tier exists to change what the reader does, and there are exactly two things they can do: ask
 * for the intro, or check first. A third tier would have to assert an ordering between `name` and
 * `surname`, and the data contradicts any fixed one — a Thai surname is strong evidence of family
 * (near-unique by law, see `COMPARE_BY_VALUES`), an English surname is mostly noise, and a given
 * name is weak in both. `full` vs not-`full` is the whole of what can be claimed honestly.
 *
 * LANGUAGE DOES NOT GRADE. A Thai full-name match and an English full-name match are the same
 * claim. Language matters *inside* the lead tier — a shared Thai surname beats a shared English one
 * — but both still land on "verify before acting", so it changes the wording in `matchReason` and
 * not the tier.
 */
export const MATCH_STRENGTHS = ['confirmed', 'lead'] as const;
export type MatchStrength = (typeof MATCH_STRENGTHS)[number];

/**
 * The mode a row was produced under, as a strength.
 *
 * Unknown and NULL modes resolve through `parseCompareBy` to `DEFAULT_COMPARE_BY`, which is a
 * `full` mode and therefore `confirmed`. That is deliberate and it is the conservative direction
 * for *display*: rows predating the column were written when every run compared whole names, so
 * grading them `lead` would badge historic full-name matches as needing verification — inventing
 * doubt about runs that never had any.
 */
export function matchStrength(mode: string | null | undefined): MatchStrength {
  return compareByAxes(parseCompareBy(mode)).type === 'full' ? 'confirmed' : 'lead';
}

/**
 * The guard that keeps the paragraph above true.
 *
 * `matchStrength` and its SQL mirror (`matchStrengthSql` in `api/src/models/row-status.ts`) both
 * resolve NULL to `DEFAULT_COMPARE_BY` and lean on it being a `full` mode — the SQL mirror's ELSE
 * branch encodes it directly. Change the default to `en_surname` without this and every NULL-mode
 * row in the database silently regrades from confirmed to lead, with no error anywhere.
 */
const DEFAULT_MUST_BE_A_FULL_MODE: `${CompareLanguage}_full` = DEFAULT_COMPARE_BY;
void DEFAULT_MUST_BE_A_FULL_MODE;

/**
 * The UNIT of the similarity number — what the percentage is a measurement OF.
 *
 * `94%` on a surname run is not wrong, it is under-labelled: it really is the trigram distance
 * between the two strings that were compared. Hiding it would destroy a real signal (a 94% surname
 * and a 61% surname are different situations), so the fix is to name what was measured — `surname
 * 94%` — rather than to suppress the measurement.
 *
 * ── `full` returns a label too, and never null (2026-07-31) ──
 *
 * It used to return null for a whole-name run, on the reasoning that a bare percent there already
 * means what it appears to mean. That is true read in isolation and false read on a screen, which is
 * where these actually appear: the Network pages pool runs of every mode into one list, so `100%`
 * and `surname 100%` sit three rows apart with nothing saying that the first one is the stronger
 * claim. An absent qualifier is not read as "whole name" — it is read as a formatting inconsistency,
 * or not read at all, and the reader is left to assume the unlabelled number is the general case.
 *
 * So all three modes name themselves and the caller no longer has a branch to get wrong. The return
 * type is `string`, not `string | null`, which is what stops the six `qualifier ? … : score`
 * conditionals this replaced from growing back one at a time.
 *
 * NOT `TYPE_LABEL`, which is the mode PICKER's vocabulary ("Name", "Surname", "Full name") and is
 * capitalised for a control. These are units in running text — `given name 94%` — and `name 94%`
 * would read as a label for the whole thing rather than for its first token.
 */
export function scoreQualifier(mode: string | null | undefined): string {
  const { type } = compareByAxes(parseCompareBy(mode));
  return type === 'full' ? 'full name' : type === 'name' ? 'given name' : 'surname';
}

/**
 * The sentence a badge tooltip carries — one implementation, because every surface that grades a
 * match has to explain it the same way.
 *
 * Takes the score ALREADY FORMATTED rather than as a number in [0, 1]. `formatSimilarity` lives in
 * `frontend/lib/format.ts` and re-implementing its rounding here to save one argument is exactly
 * the drift this package exists to prevent — the contract owns what the number MEANS, the frontend
 * owns how it reads. Pass null when no run recorded a score; the sentence drops the clause rather
 * than showing a dash, matching the "dropped, not dashed" rule the badges already follow.
 */
export function matchReason(
  mode: string | null | undefined,
  score: string | null,
  opts?: { corroborated?: boolean; importedBy?: string | null }
): string {
  const { language, type } = compareByAxes(parseCompareBy(mode));
  const dash = score ? ` — ${score}` : '';

  /**
   * Who imported the roster this connection came from — appended, never woven in.
   *
   * It is a fact about PROVENANCE and every sentence below is a fact about EVIDENCE, so it goes
   * last, in its own sentence, where it cannot dilute the check-before-you-ask warning that is the
   * point of the lead wordings. The chip's face stays the owner alone: the reader acts on whose
   * relationship it is, and needs the importer only when something looks wrong.
   *
   * Dropped, not dashed, when there is none — the same rule the score follows two lines up. A
   * tooltip reading "Imported by —" states a gap in the import record as if it were a finding about
   * the match.
   */
  const provenance = opts?.importedBy ? ` Imported by ${opts.importedBy}.` : '';

  // Corroboration outranks the mode's own wording: two independent spellings agreeing is a
  // different (and much better) reason to trust the row than anything one run can say alone.
  if (opts?.corroborated) {
    return `Matched on both Thai and English full names${dash}. Two independent spellings agree.${provenance}`;
  }

  if (type === 'full') {
    return `Whole names matched${dash}. Same person, as far as this run could tell.${provenance}`;
  }

  if (type === 'name') {
    return `Only the given name was compared${dash}. A shared given name is weak evidence on its own; check before asking for an introduction.${provenance}`;
  }

  return language === 'th'
    ? `Only the surname was compared${dash}. Thai surnames are near-unique by law, so this is strong evidence of a shared family — but still not proof of the same person; check before asking for an introduction.${provenance}`
    : `Only the surname was compared${dash}. Same family name, not necessarily the same person; check before asking for an introduction.${provenance}`;
}

// ── The split ───────────────────────────────────────────────────────────────

/** Cleaned names are single-spaced already; split defensively anyway, since the DB console writes
 *  these columns too and does not go through the cleaner. */
const tokens = (name: string): string[] => name.trim().split(/\s+/).filter(Boolean);

/**
 * The strings to score for one name under one type — several, when the type is ambiguous.
 *
 * `full`    → the name.
 * `name`    → the first token. The safest split in both languages: English and Thai alike put the
 *             given name first, and the cleaner keeps every middle token, so token[0] is never a
 *             middle name that drifted forward.
 * `surname` → the last token, PLUS the last two joined when the name has three or more tokens.
 *
 * That last rule is how the two-word-surname problem gets handled without anyone having to guess:
 * "ณ อยุธยา" and "del carmen garcia" are offered to the scorer as candidates alongside the bare
 * final token, and the trigram measure picks whichever actually resembles the other side. It is not
 * a split DECISION — nothing is discarded, so nothing can be discarded wrongly.
 *
 * The `>= 3` guard is load-bearing. On a two-token name the "last two tokens" candidate IS the
 * whole name, so without the guard `surname` would quietly decay into `full` for the commonest
 * shape of name there is, and "somchai jaidee" ↔ "narong jaidee" would score as a full-name match
 * on a run the user asked to compare surnames.
 */
export function namePartCandidates(name: string | null | undefined, type: CompareType): string[] {
  if (!name) return [];
  if (type === 'full') return [name];

  const t = tokens(name);
  if (t.length === 0) return [];
  if (type === 'name') return [t[0]];

  const last = t[t.length - 1];
  return t.length >= 3 ? [last, `${t[t.length - 2]} ${last}`] : [last];
}

/**
 * The span of a name that was in play, for the results table to mark.
 *
 * "Only 'jaidee' was ever compared" is the difference between a surname match on "somchai jaidee" ↔
 * "narong jaidee" reading as a bug and reading as the answer to the question that was asked.
 *
 * For `surname` on a three-token name this returns the WIDEST candidate — the last two tokens —
 * because both were scored and the reader cannot be told which one won (the stored row keeps one
 * similarity, not one per candidate). The widest span is the honest claim: this is the region the
 * matcher considered.
 */
export function namePartSpan(
  name: string | null | undefined,
  type: CompareType
): { before: string; match: string; after: string } | null {
  if (!name) return null;
  if (type === 'full') return { before: '', match: name, after: '' };

  const t = tokens(name);
  if (t.length <= 1) return { before: '', match: name, after: '' };

  if (type === 'name') {
    return { before: '', match: t[0], after: ` ${t.slice(1).join(' ')}` };
  }

  const take = t.length >= 3 ? 2 : 1;
  const head = t.slice(0, t.length - take);
  return { before: head.length ? `${head.join(' ')} ` : '', match: t.slice(t.length - take).join(' '), after: '' };
}
