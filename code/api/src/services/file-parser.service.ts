import type { ColumnMapping, ColumnOverrides, UploadPreview } from '@extensions/contract';
import type { CompanyContactRecord } from '../models/company-contact.model';
import type { FriendRecord } from '../models/friend.model';
import { readTable } from '../lib/table-file';
import { hasThai } from '@extensions/contract';
import { cleanOwnerName, cleanPersonName, tidyText, wasCleaned } from './name-cleaner.service';

/**
 * Reads the files this app accepts — a workbook, a CSV or a JSON export, for both sources — and
 * describes what it read.
 *
 * Format is settled below this, in `readTable`: whichever of the three a user hands over arrives
 * here as headers and rows, so a column alias, a cleaning rule and a warning are written once and
 * hold for every format. A file's *shape* is still its own business — the column names are what
 * this file matches on, and a JSON export and a spreadsheet of the same data have the same ones.
 *
 * `parse*` is what the import runs; `preview*` is what the upload screen shows beforehand.
 * They resolve headers and map rows through the *same* functions (`buildMapping`,
 * `mapCompanyRow`), so the preview cannot promise a column the import won't fill. That
 * shared path is the whole point — a preview that disagrees with the import is worse than
 * none, because it's believed.
 *
 * Every person's name is cleaned here (name-cleaner.service.ts) and the cleaned name is what
 * the record carries — there is no raw twin, in the record or in the database. Which makes the
 * preview load-bearing rather than decorative: it is the *only* chance to see the original text
 * next to what will be stored, so it reads the record for the cleaned value rather than
 * re-deriving it, and cannot drift from what the import writes.
 */

/** A target column, and the headers a file may use to supply it. The real company export
 *  uses the underscored names; the spaced ones are accepted for hand-made files.
 *  `isName` marks a person's name — the columns that get cleaned. */
interface FieldSpec {
  target: string;
  label: string;
  aliases: string[];
  isName?: boolean;
  /**
   * A person's name that is cleaned but NOT lower-cased — see `cleanOwnerName`. Only the
   * relationship owner: it is grouped case-insensitively and then shown to somebody as the
   * person to go and ask, so folding its case would rewrite every roster label in the app.
   */
  isOwner?: boolean;
  /**
   * A slot with no column behind it: the UNLABELLED name, routed to a language by script.
   *
   * Detection may fill it — that is how a Facebook export's bare `name` is read — but a user
   * may not, so the preview offers no picker for it. Mapping a column here by hand would be
   * asking someone to choose "let the app guess the language" over saying which language it is,
   * next to two rows that say it outright; and on a file where the labelled columns were both
   * detected, the row is a leftover with nothing left to hold.
   */
  isGeneric?: boolean;
  /**
   * The two halves of a split name, when a file writes one instead of a whole one.
   *
   * LinkedIn's `Connections.csv` and most CRM exports have “First Name” and “Last Name” and no
   * column holding both. One target resolves to one column, so such a file used to detect no name
   * at all — and the picker couldn't rescue it either, because picking either half imports half of
   * everybody's name. Detected as a PAIR and joined, which is the only reading that keeps the
   * whole name. Tried after the single-column aliases: a file with both a full name and its parts
   * means the full one.
   */
  parts?: { first: string[]; last: string[] };
  /**
   * This target may be filled by reading the DATA when no header matched — see `guessNameColumn`.
   *
   * The language-labelled name columns only. Not the owner (a column full of people's names is far
   * more likely to be the friends than the person who knows them, and guessing wrong there merges
   * rosters), not the company, and not the unlabelled slot, which has no column of its own.
   */
  guessable?: boolean;
}

// The language spellings mirror FACEBOOK_FIELDS below, `en_name`/`th_name` included: the two
// sides of an import come out of the same exporters, and a header vocabulary one file is allowed
// to use and the other isn't would be a difference with no reason behind it.
// Headers match on letters and digits alone (see `norm`), so one spelling here covers every way a
// file writes it: 'company_name' also answers "Company Name", "company-name" and "Company (Name)".
// What still has to be listed is a different WORD for the same thing — and those are what the
// pickers on the preview screen kept being asked about, one file after another.
const COMPANY_FIELDS: FieldSpec[] = [
  {
    target: 'company_name',
    label: 'Company',
    aliases: [
      'company_name',
      'Company Name',
      'company',
      'organisation',
      'organization',
      'organisation name',
      'organization name',
      'org',
      'employer',
      'account',
      'account name',
      'firm',
      'workplace',
      'บริษัท',
      'ชื่อบริษัท',
      'องค์กร',
      'หน่วยงาน',
    ],
  },
  /**
   * The contact's name where the file does NOT say which language it is in — the company side's
   * copy of `friend_name`, and new here for the same reason that one exists.
   *
   * A header like "Contact Person", "Full Name" or "ชื่อ-นามสกุล" names a person and claims nothing
   * about the script. Filing those under `person_name_en` — where they would have had to go, since
   * this side had only the two labelled slots — asserts English about a column that may well hold
   * Thai, and a Thai run would then report the whole import as unmatched. Routed by script instead,
   * by the same rule the friends side has always used.
   *
   * This is also the slot the split-name pair and the read-the-data guess land in, and for the same
   * reason: neither knows a language either.
   */
  {
    target: 'person_name',
    label: 'Contact name',
    aliases: [
      'contact name',
      'contact person',
      'contact',
      'person name',
      'person',
      'full name',
      'fullname',
      'display name',
      'ชื่อ',
      'ชื่อ-นามสกุล',
      'ชื่อ-สกุล',
      'ชื่อนามสกุล',
      'ชื่อผู้ติดต่อ',
    ],
    isName: true,
    isGeneric: true,
    guessable: true,
    parts: {
      first: ['first name', 'firstname', 'given name', 'givenname', 'forename', 'ชื่อจริง', 'ชื่อต้น'],
      last: ['last name', 'lastname', 'surname', 'family name', 'familyname', 'นามสกุล', 'สกุล'],
    },
  },
  {
    target: 'person_name_th',
    label: 'Thai name',
    aliases: ['thai_name', 'th_name', 'Thai Name', 'thai', 'name_th', 'ชื่อไทย', 'ชื่อภาษาไทย'],
    isName: true,
  },
  {
    target: 'person_name_en',
    label: 'English name',
    aliases: [
      'eng_name',
      'en_name',
      'English Name',
      'English',
      'eng',
      'name_en',
      'ชื่ออังกฤษ',
      'ชื่อภาษาอังกฤษ',
    ],
    isName: true,
  },
];

/** Facebook friends, as a table. The JSON export's own key name (`name`) leads the aliases: it is
 *  what that export writes, and what a workbook made by pasting it in keeps.
 *
 *  The export's `timestamp` ("friended on") used to be read into `friend.source_timestamp`.
 *  Nothing ever matched, grouped or filtered on it — it only ordered the grid — so the column
 *  is gone and the header is now simply one of the ones this file ignores. */
const FACEBOOK_FIELDS: FieldSpec[] = [
  /**
   * The friend's name, once per language — symmetric with `COMPANY_FIELDS` above.
   *
   * There was one field here until 2026-07-28, and a Thai name column on a friends file was
   * therefore listed under "Ignored (nothing maps to them)" in the preview and then thrown away.
   * That was defensible while the only social export in play was Facebook's, which writes a single
   * `name`; it stopped being defensible once `upload_source` made a business card — which prints
   * both spellings — a first-class import type.
   *
   * `friend_name_en` keeps the ORIGINAL alias list, unchanged and leading. A single-name file has
   * always been an English-ish file in practice (`DEFAULT_COMPARE_BY` is `en_full`), so a bare
   * `name` column must keep landing exactly where it always did, or every existing file would
   * silently start importing differently.
   */
  //
  // THREE fields, not two, because a file can label a name column or not, and the two cases have
  // to be read differently. `friend_name` is the UNLABELLED one — a Facebook export's `name`,
  // which says nothing about which language it holds — and `mapFriendRow` routes it by script,
  // the same rule the 2026-07-28 backfill applied to the column this replaced. Routing it
  // unconditionally to English would have filed every Thai-script Facebook export under the
  // English column, where a Thai run would then report the whole roster as "Not compared".
  {
    target: 'friend_name',
    label: 'Friend name',
    aliases: [
      'name',
      'friend_name',
      'Friend Name',
      'Facebook Name',
      'fb_name',
      'full_name',
      // Language-neutral spellings, all of them naming a person and none of them naming a script —
      // which is what this slot is for. They were absent, so a file calling its one name column
      // "Contact" or "ชื่อ-นามสกุล" reached the preview with nothing detected: three pickers, and a
      // user asked to answer a question the app could perfectly well have answered itself.
      'contact',
      'contact name',
      'contact person',
      'person name',
      'display name',
      'profile name',
      'user name',
      'ชื่อ',
      'ชื่อ-นามสกุล',
      'ชื่อ-สกุล',
      'ชื่อนามสกุล',
      'ชื่อผู้ติดต่อ',
    ],
    isName: true,
    isGeneric: true,
    guessable: true,
    // LinkedIn's Connections.csv, and every CRM export shaped like it. Joined rather than picked
    // between: half a name is not a name. See `FieldSpec.parts`.
    parts: {
      first: ['first name', 'firstname', 'given name', 'givenname', 'forename', 'ชื่อจริง', 'ชื่อต้น'],
      last: ['last name', 'lastname', 'surname', 'family name', 'familyname', 'นามสกุล', 'สกุล'],
    },
  },
  // `en_name` / `th_name` sit beside `name_en` / `name_th` because both orders are written in
  // practice and neither is more correct — a bilingual export produced against this app's own
  // vocabulary uses the language first. Missing them cost nothing visible until the preview
  // started offering to map what it couldn't detect: a file with these headers reported FOUR
  // unmapped columns, and every one of them was a column the app could perfectly well have
  // recognised itself. A picker is for a header nobody could have predicted, not for a spelling.
  {
    target: 'friend_name_en',
    label: 'Friend name (English)',
    aliases: [
      'friend_name_en',
      'eng_name',
      'en_name',
      'English Name',
      'name_en',
      'Friend Name (English)',
      'ชื่ออังกฤษ',
      'ชื่อภาษาอังกฤษ',
    ],
    isName: true,
  },
  {
    target: 'friend_name_th',
    label: 'Friend name (Thai)',
    aliases: [
      'friend_name_th',
      'thai_name',
      'th_name',
      'Thai Name',
      'thai',
      'name_th',
      'Friend Name (Thai)',
      'ชื่อไทย',
      'ชื่อภาษาไทย',
    ],
    isName: true,
  },
  /**
   * Whose relationship each friend is — when the file says so.
   *
   * A friends export can hold several people's contacts, so the owner is a property of the ROW.
   * When a file carries this column the import reads each friend's own owner off it and requires
   * nothing to be typed; when it doesn't, `buildMapping` resolves `sourceColumn` to null, every
   * row comes back unowned, and the typed value is the only answer there is. A typed value still
   * wins where it is given — it is an override, not a patch for the gaps. Nothing detects this
   * twice: the preview's `mapping` is the same object the import maps rows through, so the
   * question the screen asks and the behaviour the import has cannot disagree.
   */
  {
    target: 'relationship_owner',
    label: 'Relationship owner',
    aliases: [
      'relationship_owner',
      'owner',
      'known by',
      'known_by',
      'friend of',
      'friend_of',
      'whose friend',
      'whose_friend',
      'contact owner',
      'contact_owner',
      'belongs to',
      'belongs_to',
      'introducer',
      'introduced by',
      'referred by',
      'referrer',
      'added by',
      'connection owner',
      'account owner',
      'sales owner',
      'ผู้แนะนำ',
      'เจ้าของ',
      'รู้จักโดย',
    ],
    isOwner: true,
  },
];

/**
 * How many rows the preview *carries*. Not how many it shows: the screen reveals them ten at
 * a time, so this is the size of the pool that "Show 10 more" draws from.
 *
 * Eight was enough to catch a wrong column and nothing else. Spotting a bad *export* — names
 * that shifted a column halfway down, a stray footer row — needs more than the top of the
 * file, and the cost is a handful of extra rows on a request that already carries the whole
 * upload. It stays bounded because the point is a sample, not the file.
 */
const SAMPLE_SIZE = 50;

/**
 * Headers match on their letters and digits alone: "Thai Name" == "thai_name" == "Thai-Name".
 *
 * It used to fold whitespace and underscores only, which made the alias lists a catalogue of
 * PUNCTUATION rather than of vocabulary: "Name (EN)", "name-en" and "name.en" are the same header
 * written three ways, and each one that wasn't listed arrived at the preview as a column nothing
 * could find. Dropping every separator answers all of them at once, and leaves the lists to hold
 * what they should — the different WORDS a file uses for the same thing.
 */
const norm = (s: string): string => s.replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();

/** The last segment of a flattened JSON key: `profile.name` → `name`. Plain headers have none,
 *  and answer as themselves. */
const leaf = (header: string): string => header.slice(header.lastIndexOf('.') + 1);

/**
 * The header an alias list finds in this file, or null.
 *
 * Two passes, and the order between them matters: a whole header beats a nested one for EVERY
 * alias before any nested key is considered. A file with both a top-level `name` and a
 * `profile.name` means the top-level one, and doing it alias-by-alias would let a later alias
 * matching a nested key beat an earlier alias matching a real column.
 *
 * The nested pass is what makes a JSON export's `profile.name` detectable at all. The reader now
 * flattens nesting into dotted columns (json-rows.ts) so the key is visible and selectable; this
 * is the other half — a key called `name` one level down is still a key called `name`.
 */
const detect = (aliases: string[], headers: string[]): string | null => {
  const whole = aliases
    .map((a) => headers.find((h) => norm(h) === norm(a)))
    .find((h) => h !== undefined);
  if (whole !== undefined) return whole;

  const nested = aliases
    .map((a) => headers.find((h) => h.includes('.') && norm(leaf(h)) === norm(a)))
    .find((h) => h !== undefined);
  return nested ?? null;
};

/** How many rows the column guess reads. A column's character is obvious well before this, and
 *  the whole file is already in memory — this only bounds the work, not the evidence. */
const GUESS_SAMPLE = 200;

/**
 * Does this header hint that people's names live in it? Not an alias — an alias is a whole header,
 * this is a word inside one, and it only ever tips a guess between columns that look alike.
 *
 * Whole WORDS on the Latin side, with separators read as spaces first, so "contact_name" hints and
 * "nickname" does not: a nickname column is not the column a roster is built on, and a substring
 * test hands it the same standing as "Full Name". Thai is written without word breaks, so there
 * substring is the only test there is.
 */
const hasNameHint = (header: string): boolean =>
  /\b(name|contact|person|friend)\b/i.test(header.replace(/[_\-.]+/g, ' ')) ||
  ['ชื่อ', 'สกุล'].some((k) => header.includes(k));

/**
 * Does this value look like a person's name?
 *
 * Deliberately a test of SHAPE, not of meaning — it is asked of a column whose header told us
 * nothing, and the only evidence left is what the cells look like. It is written to be easy to
 * fail: a digit, an @, a URL or more than five words all disqualify, which rules out ids, emails,
 * phone numbers, dates, addresses, job titles-with-numbers and free-text notes. What survives is
 * a short run of letters and the punctuation names actually carry.
 */
function looksLikePersonName(value: string): boolean {
  if (value.length < 2 || value.length > 60) return false;
  if (/\d/.test(value)) return false;
  if (value.includes('@') || value.includes('://')) return false;
  if (value.split(/\s+/).length > 5) return false;
  if (!/\p{L}/u.test(value)) return false;
  // \p{M} as well as \p{L}: Thai vowels and tone marks are combining marks, not letters, so a
  // letters-only test calls every Thai name malformed — which is the wrong way round for a rule
  // whose whole job is spotting the Thai name column nothing else could find.
  return !/[^\p{L}\p{M}\s.'’\-()"]/u.test(value);
}

/**
 * The column that holds people's names, worked out from the DATA — the last thing tried, and only
 * when no header named a name column at all.
 *
 * The case it exists for is the one the bug report is about: a file whose name column is called
 * something no alias list could have predicted. Detection had nothing to say about those, so the
 * preview asked the user to map every slot by hand — on a file where the answer is obvious to
 * anyone who looks at one row of it.
 *
 * A guess needs to be RIGHT more than it needs to be brave, so a column has to clear two bars, not
 * one: four cells in five must look like a name (`looksLikePersonName`), AND the header must hint
 * at names or most of the values must be more than one word. Name-shaped alone is far too easy —
 * a column of single ordinary words ("Sales", "Active", "Bangkok") passes it, and the import would
 * then cheerfully file a column of departments as people. Among the columns that do clear both,
 * mostly-distinct values count for more: a roster repeats companies and job titles, and rarely
 * repeats a person.
 *
 * The winner is marked `guessed` all the way to the screen, which says so and offers the same
 * picker as ever — a guess is an opening bid, not a decision taken on the user's behalf.
 */
function guessNameColumn(headers: string[], rows: Record<string, string>[]): string | null {
  const sample = rows.slice(0, GUESS_SAMPLE);
  let best: string | null = null;
  let bestScore = 0;

  for (const header of headers) {
    const values = sample.map((r) => (r[header] ?? '').trim()).filter((v) => v !== '');
    if (values.length === 0) continue;

    const nameish = values.filter(looksLikePersonName).length / values.length;
    if (nameish < 0.8) continue;

    const hinted = hasNameHint(header);
    const multiword = values.filter((v) => v.split(/\s+/).length > 1).length / values.length;
    if (!hinted && multiword < 0.5) continue;

    const distinct = new Set(values.map((v) => v.toLowerCase())).size / values.length;
    const score = nameish + (hinted ? 1 : 0) + distinct * 0.5;
    if (score > bestScore) {
      bestScore = score;
      best = header;
    }
  }
  return best;
}

/**
 * The three name slots each side has: the unlabelled column, and the two labelled ones it routes
 * into. Named once here because three functions have to agree about them — the router, the
 * preview's raw/clean pairing and the "is this file usable" warnings — and a fourth spelling of
 * "friend_name_th" is how the preview and the import start describing different files.
 */
interface NameSlots {
  generic: string;
  en: string;
  th: string;
}

const FRIEND_SLOTS: NameSlots = { generic: 'friend_name', en: 'friend_name_en', th: 'friend_name_th' };
const COMPANY_SLOTS: NameSlots = { generic: 'person_name', en: 'person_name_en', th: 'person_name_th' };

/** What resolution decided about one target, before it becomes a `ColumnMapping`. */
interface Resolved {
  sourceColumn: string | null;
  alsoColumn?: string | null;
  guessed?: boolean;
}

/**
 * Resolve each target column to the header that supplies it, or null if the file has none.
 *
 * Four tiers, tried in order, each seeing only the headers the ones above it left alone:
 *
 *   1. What the USER said — a target they named a column for takes that column, whatever anything
 *      else thinks, and `null` means "take nothing" (the only way to undo a wrong detection).
 *   2. The ALIAS lists — the vocabulary of the exports this app knows.
 *   3. A name written as TWO columns — "First Name" + "Last Name", joined.
 *   4. The DATA — when no header named a name column at all, the column that is full of things
 *      shaped like people's names. Marked `guessed`, and never silent.
 *
 * Tiers 3 and 4 are new, and they are the "it doesn't auto-match" half of the bug they answer:
 * before them a file whose headers weren't on a list resolved to nothing at all. Tier 1 running
 * FIRST is the other half — until it did, a hand-mapped column could be claimed out from under
 * the user by an alias that matched the same header for a different target.
 */
function buildMapping(
  fields: FieldSpec[],
  headers: string[],
  rows: Record<string, string>[],
  overrides: ColumnOverrides = {}
): ColumnMapping[] {
  const resolved = new Map<string, Resolved>();
  /** Headers already spoken for. A column feeds one target, so each tier below only sees what
   *  the tiers above it left — which is what stops a guess re-using a column detection found. */
  const taken = new Set<string>();
  const free = () => headers.filter((h) => !taken.has(h));

  const claim = (target: string, r: Resolved) => {
    resolved.set(target, r);
    if (r.sourceColumn) taken.add(r.sourceColumn);
    if (r.alsoColumn) taken.add(r.alsoColumn);
  };

  // ── 1. What the user said, first — so nothing below can claim a column they spoke for ───────
  // A generic slot takes detection only: the picker that would fill it isn't offered, and
  // honouring a choice nothing can make would be a second way in with no way to see it.
  for (const f of fields) {
    if (f.isGeneric || !(f.target in overrides)) continue;
    const want = overrides[f.target];
    // Explicitly nothing. This is how a column detection got WRONG is emptied — see
    // `ColumnOverridesSchema`. It has to sit in `resolved`, or the tiers below would fill it back in.
    if (want === null) {
      claim(f.target, { sourceColumn: null });
      continue;
    }
    // Matched the same forgiving way an alias is, so a header round-tripped through a UI or a
    // hand-written script ("Thai Name" vs "thai_name") still lands on the column it names.
    const header = detect([want], headers);
    // A named header the file does NOT have is ignored rather than honoured as null, and detection
    // runs for that target as usual — the file-swapped-underneath case.
    if (header) claim(f.target, { sourceColumn: header });
  }

  // ── 2. The alias lists ──────────────────────────────────────────────────────────────────────
  for (const f of fields) {
    if (resolved.has(f.target)) continue;
    const header = detect(f.aliases, free());
    if (header) claim(f.target, { sourceColumn: header });
  }

  // ── 3. A name written as two columns ────────────────────────────────────────────────────────
  // After the aliases, deliberately: a file carrying both a whole name and its parts means the
  // whole one, and only a file with no single name column needs these joined.
  for (const f of fields) {
    if (resolved.has(f.target) || !f.parts) continue;
    const first = detect(f.parts.first, free());
    const last = detect(f.parts.last, free());
    if (first && last) claim(f.target, { sourceColumn: first, alsoColumn: last });
  }

  // ── 4. Reading the data, when no header named a name at all ─────────────────────────────────
  // Gated on the whole file, not on one target: a bilingual export that found its Thai column and
  // not its English one has nothing missing, and guessing at the remaining columns there would be
  // inventing a second name for people who have one.
  const named = fields.some((f) => f.isName && resolved.get(f.target)?.sourceColumn);
  if (!named) {
    const guessable = fields.find((f) => f.guessable && !resolved.has(f.target));
    const header = guessable ? guessNameColumn(free(), rows) : null;
    if (guessable && header) claim(guessable.target, { sourceColumn: header, guessed: true });
  }

  return fields.map(({ target, label, isName, isOwner, isGeneric }) => {
    const r = resolved.get(target);
    return {
      target,
      label,
      sourceColumn: r?.sourceColumn ?? null,
      alsoColumn: r?.alsoColumn ?? null,
      // `cleaned` tells the preview which cells have a `<target>_clean` twin to show. An owner
      // gets one too: it is cleaned (titles stripped), so the file's own spelling is worth showing
      // beside what will be stored, for the same reason a friend's name is.
      cleaned: isName === true || isOwner === true,
      pickable: isGeneric !== true,
      guessed: r?.guessed === true,
    };
  });
}

/** Headers the file has that no target column claims — the import will ignore them. */
const ignoredColumns = (headers: string[], mapping: ColumnMapping[]): string[] => {
  const claimed = new Set(mapping.flatMap((m) => [m.sourceColumn, m.alsoColumn]).filter(Boolean));
  return headers.filter((h) => !claimed.has(h));
};

/** One header's value in a raw row. Empty string is absence, not a value. */
const headerCell = (row: Record<string, unknown>, header: string | null): string | null => {
  if (!header) return null;
  const v = row[header];
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

/** Pull one target column out of a raw row — both halves of it, where the file splits a name
 *  across two columns (`alsoColumn`). One half present and the other blank is still a value:
 *  a person with no surname in the file has a name, and it is the half that is there. */
const cell = (row: Record<string, unknown>, m: ColumnMapping | undefined): string | null => {
  if (!m) return null;
  const parts = [headerCell(row, m.sourceColumn), headerCell(row, m.alsoColumn ?? null)].filter(
    (v): v is string => v !== null
  );
  return parts.length === 0 ? null : parts.join(' ');
};

/** The raw cells a row supplies, keyed by target column — the file's own words, before cleaning.
 *  Only the preview reads this: the import stores cleaned names and nothing else. */
const rawRow = (row: Record<string, unknown>, mapping: ColumnMapping[]): Record<string, string | null> =>
  Object.fromEntries(mapping.map((m) => [m.target, cell(row, m)]));

const mapCompanyRow = (row: Record<string, string>, mapping: ColumnMapping[]): CompanyContactRecord => {
  const by = (target: string) => cell(row, mapping.find((m) => m.target === target));
  // Routed by script exactly as a friend's is — see `routeNames`. The company side gained an
  // unlabelled slot when it gained headers that name a person without naming a language.
  const { en, th } = routeNames(
    cleanPersonName(by('person_name')),
    cleanPersonName(by('person_name_en')),
    cleanPersonName(by('person_name_th'))
  );
  return {
    // A company name is only ever grouped and matched exactly, so it's tidied (whitespace,
    // invisible characters) but never de-titled: "Mr Pizza Co." is a company called Mr Pizza.
    company_name: tidyText(by('company_name')),
    person_name_th: th,
    person_name_en: en,
  };
};

/**
 * Put the file's names into the right columns.
 *
 * An EXPLICITLY LABELLED column is believed: a header called "thai_name" holds a Thai name whatever
 * its characters look like, and the file is a better authority on that than a regex is.
 *
 * An UNLABELLED name — a Facebook export's bare `name` — has no such claim attached, so it is
 * routed by script, using exactly the rule the 2026-07-28 backfill used on the single column this
 * replaced. Thai characters never appear incidentally inside a Latin name, whereas Latin initials
 * and punctuation appear inside Thai names routinely, so the presence of Thai is the stronger
 * signal; anything with no Thai in it (including CJK, an emoji or a handle) goes to English,
 * matching `DEFAULT_COMPARE_BY`'s bias, because the alternative is landing in no column at all.
 *
 * It only ever FILLS: a labelled column already holding a value is never displaced by the generic
 * one, which is the same "fill nulls, never overwrite" stance the import takes against the database.
 *
 * Both sides run this. It was `routeFriendNames` while only the friends file had an unlabelled
 * name column; a company file now has one too (`person_name`), and one rule shared is the only way
 * the two sides can't drift on the question of which column a Thai name lands in.
 */
function routeNames(
  generic: string | null,
  en: string | null,
  th: string | null
): { en: string | null; th: string | null } {
  if (generic) {
    if (hasThai(generic)) th = th ?? generic;
    else en = en ?? generic;
  }
  return { en, th };
}

const mapFriendRow = (row: Record<string, string>, mapping: ColumnMapping[]): FriendRecord => {
  const by = (target: string) => cell(row, mapping.find((m) => m.target === target));
  const { en, th } = routeNames(
    cleanPersonName(by('friend_name')),
    cleanPersonName(by('friend_name_en')),
    cleanPersonName(by('friend_name_th'))
  );
  return {
    friend_name_en: en,
    friend_name_th: th,
    // Cleaned but case-preserving — see cleanOwnerName. Null when the file has no owner column
    // OR when this particular row left it blank; both are "the file did not say", the typed owner
    // answers both, and nothing here needs to tell them apart.
    relationship_owner: cleanOwnerName(by('relationship_owner')),
  };
};

/**
 * The preview's row: what the file says, next to what will be stored.
 *
 * `<target>` is the file's raw cell and `<target>_clean` is the value the import will write —
 * read back off the record rather than re-derived, so the two cannot disagree. This pairing is
 * now the only place the original text is ever visible: it is not stored, so a name the cleaner
 * gets wrong has to be caught here or not at all.
 */
const previewRow = (
  raw: Record<string, string | null>,
  record: CompanyContactRecord | FriendRecord,
  mapping: ColumnMapping[],
  slots: NameSlots
): Record<string, string | null> => {
  const stored = record as unknown as Record<string, string | null | undefined>;
  const out: Record<string, string | null> = {};
  for (const m of mapping) {
    if (m.cleaned) {
      // A name column: the raw cell, plus the cleaned value that will be stored beneath it.
      out[m.target] = raw[m.target] ?? null;
      // The unlabelled slot is the one target with no column of its own — `routeNames` sends its
      // cell to whichever language the script indicates. So the stored value is looked up in the
      // column it landed in, using the same script test that put it there. Cleaning never changes
      // a name's script, so testing the RAW cell agrees with the routing by construction, and the
      // value still comes off the record rather than being re-derived.
      //
      // Except when the labelled column it routes into ALREADY has a value: routing only ever
      // fills, so this cell was not used at all. `null` is how the sample says "not imported", and
      // saying it here is the difference between a dropped cell being visible on this screen and
      // being discovered in the data. It is a file with both a labelled and an unlabelled name
      // column — an odd shape, and exactly the shape a wrong detection makes.
      out[`${m.target}_clean`] =
        m.target === slots.generic
          ? raw[slots.generic]
            ? (() => {
                const routed = hasThai(raw[slots.generic] as string) ? slots.th : slots.en;
                return raw[routed] ? null : stored[routed] ?? null;
              })()
            : null
          : stored[m.target] ?? null;
    } else {
      // company_name is tidied (whitespace/invisible chars) but not "cleaned", and it is the
      // TIDIED value that gets stored — so show that, not the raw cell. Showing the raw cell here
      // would put a double-spaced "Acme  Co" in the preview above an "Acme Co" in the database:
      // the preview promising something the import does not do, on the one column it is silent about.
      out[m.target] = stored[m.target] ?? raw[m.target] ?? null;
    }
  }
  return out;
};

/**
 * How many importable rows carry a name in each language — the count an import's run turns into a
 * requirement. See `ScorableRowsSchema` for why it is counted here rather than read off the
 * mapping: an unlabelled column is routed by script, so this is a question about cells.
 *
 * Nameless rows are excluded by construction — a row with no name in either language is counted in
 * neither — which is the same set the `usable` gate in comparisons.route.ts drops.
 *
 * Thai was dropped on 2026-08-05, when every import was pinned to `en_full` and the number had no
 * reader. It is back with the mode picker (2026-08-10), because the count is what the gate REFUSES
 * on: with only `en` available the refusal could not distinguish "this file has no names we can read"
 * from "this file's names are all Thai", and the second one has an obvious fix that the first does
 * not. Both sides of an import are counted the same way, since either can be the file being read.
 */
const scorableRows = (
  mapped: {
    person_name_en?: string | null;
    person_name_th?: string | null;
    friend_name_en?: string | null;
    friend_name_th?: string | null;
  }[]
): { en: number; th: number } => ({
  en: mapped.filter((r) => r.person_name_en ?? r.friend_name_en).length,
  th: mapped.filter((r) => r.person_name_th ?? r.friend_name_th).length,
});

/**
 * "No header named the names, so ‘f_002’ was read as them" — said out loud, in the warnings, not
 * only as a badge on a table row.
 *
 * A guess is the one thing on this screen the file did not say and detection did not know, so it
 * is the one thing most worth a reader's attention — and the row it sits on is easy to skim past
 * on a file where everything else looks right. The wording names the column and says what to do
 * if it is wrong, because "check this" without a next step is just unease.
 */
function guessNote(mapping: ColumnMapping[]): string[] {
  return mapping
    .filter((m) => m.guessed && m.sourceColumn)
    .map(
      (m) =>
        `No header named the names, so “${m.sourceColumn}” was read as them — it is the column that looks most like people's names. If that's wrong, pick the right one below.`
    );
}

/** "3 names will be cleaned…" — the preview's account of what cleaning will do to this file, so
 *  it's a thing you agreed to rather than a thing you discover in the grid afterwards.
 *
 *  It no longer promises the original is kept, because it isn't. `dropped` is called out
 *  separately: a name that cleans to nothing was pure decoration, and its row will not import. */
function cleaningNote(pairs: [raw: string | null, clean: string | null][]): string[] {
  const present = pairs.filter(([raw]) => raw !== null);
  const changed = present.filter(([raw, clean]) => wasCleaned(raw, clean)).length;
  const dropped = present.filter(([, clean]) => clean === null).length;

  const notes: string[] = [];
  if (changed > 0) {
    notes.push(
      changed === 1
        ? '1 name will be cleaned: titles, suffixes and nicknames removed, the rest lower-cased. The original is not kept, so check it in the sample before importing.'
        : `${changed.toLocaleString()} names will be cleaned: titles, suffixes and nicknames removed, the rest lower-cased. The originals are not kept, so check the sample before importing.`
    );
  }
  if (dropped > 0) {
    notes.push(
      dropped === 1
        ? '1 name is only a title (like “Mr”) with no name behind it, and will not be imported.'
        : `${dropped.toLocaleString()} names are only titles (like “Mr”) with no name behind them, and will not be imported.`
    );
  }
  return notes;
}

export class FileParserService {
  /**
   * Parse a company file into contact records.
   *
   * `overrides` are the columns the user mapped by hand on the preview screen, passed back
   * unchanged at import — see `buildMapping`. The import and the preview take the same argument
   * and hand it to the same function, which is what stops the screen promising a column the
   * import won't fill.
   */
  static async parseCompanyFile(filePath: string, overrides: ColumnOverrides = {}): Promise<CompanyContactRecord[]> {
    const { headers, rows } = await readTable(filePath);
    const mapping = buildMapping(COMPANY_FIELDS, headers, rows, overrides);
    return rows.map((r) => mapCompanyRow(r, mapping));
  }

  /** Parse a Facebook friends file into friend records. */
  static async parseFacebookFile(filePath: string, overrides: ColumnOverrides = {}): Promise<FriendRecord[]> {
    const { headers, rows } = await readTable(filePath);
    const mapping = buildMapping(FACEBOOK_FIELDS, headers, rows, overrides);
    return rows.map((r) => mapFriendRow(r, mapping));
  }

  /** What a company file would import, without importing it. */
  static async previewCompanyFile(
    filePath: string,
    fileName: string,
    overrides: ColumnOverrides = {}
  ): Promise<UploadPreview> {
    const { headers, rows } = await readTable(filePath);
    const mapping = buildMapping(COMPANY_FIELDS, headers, rows, overrides);
    const mapped = rows.map((r) => mapCompanyRow(r, mapping));
    const raws = rows.map((r) => rawRow(r, mapping));

    const warnings: string[] = [];
    if (rows.length === 0) warnings.push('This file has no rows to import.');

    // The NAME columns, asked ONCE — the three slots are three ways of answering one question, and
    // a file only has to answer it once. Per target this warned about the unlabelled slot on every
    // bilingual file, and pointed at a row that deliberately offers no picker. Same rule as the
    // friends side below, for the same reason.
    if (!mapping.some((m) => m.target.startsWith('person_name') && m.sourceColumn)) {
      warnings.push(
        "No column matched a contact's name — pick the column the names are in below, or this file will import nothing."
      );
    }

    warnings.push(...guessNote(mapping));

    /**
     * Contacts with no COMPANY — the one column a company file must have besides the names.
     *
     * The company is the axis every run is selected by, so a contact filed under nothing can never
     * be compared: it is not in "PTT", it is not in "all companies I picked", it is nowhere. Every
     * row of a company file being like that means the file has no company column at all (or an
     * empty one), which the import refuses — see comparisons.route.ts, which counts the same rows
     * the same way so the screen and the import cannot disagree.
     *
     * Counted over IMPORTABLE rows only, exactly as `ownerlessRows` is: a row with no person name
     * is dropped anyway, and holding its blank company against the file would block an import that
     * was never going to include it.
     *
     * This is the ONLY warning about the company column, and it deliberately replaced a second one
     * that fired off the mapping alone ("No column matched “Company” … or it will be empty on every
     * row"). Two messages about one missing column is one too many, and that one was now wrong
     * besides: an empty company column does not leave the rows empty, it stops the import.
     */
    const importable = mapped.filter((r) => r.person_name_th || r.person_name_en);
    const companylessRows = importable.filter((r) => !r.company_name).length;
    if (companylessRows > 0) {
      const hasColumn = !!mapping.find((m) => m.target === 'company_name')?.sourceColumn;
      warnings.push(
        companylessRows === importable.length
          ? hasColumn
            ? 'No row names a company — the company column is empty on every row, and a contact with no company can never be compared. This file cannot be imported.'
            : "No column matched the company — pick the column it's in below. A contact with no company can never be compared, so this file cannot be imported without one."
          : `${companylessRows.toLocaleString()} row${companylessRows === 1 ? ' names' : 's name'} no company. ${
              companylessRows === 1 ? 'It' : 'They'
            } will import, but no run can reach ${companylessRows === 1 ? 'it' : 'them'} — every comparison is selected by company.`
      );
    }

    // A contact the matcher cannot score is a contact that will not import — see the `usable`
    // gate in comparisons.route.ts, which this warning has to agree with. Counted on the
    // CLEANED names, because those are what will be stored and what that gate reads.
    const unusable = mapped.filter((r) => !r.person_name_th && !r.person_name_en).length;
    if (unusable > 0) {
      warnings.push(
        unusable === 1
          ? '1 row has no person name and will not be imported — there would be nothing to match it on.'
          : `${unusable.toLocaleString()} rows have no person name and will not be imported — there would be nothing to match them on.`
      );
    }

    // Counted across the whole file, not just the sample — the sample is what you see, but
    // the number has to describe what will actually be written. The unlabelled slot is in here
    // too: its cell is cleaned like any other name, and it is the only column some files have.
    warnings.push(
      ...cleaningNote(
        raws.flatMap((raw, i): [string | null, string | null][] => [
          [raw.person_name_th, mapped[i].person_name_th],
          [raw.person_name_en, mapped[i].person_name_en],
          [raw.person_name, mapped[i].person_name_th ?? mapped[i].person_name_en],
        ])
      )
    );

    return {
      kind: 'company',
      fileName,
      totalRows: rows.length,
      sourceColumns: headers,
      ignoredColumns: ignoredColumns(headers, mapping),
      mapping,
      sampleRows: raws.slice(0, SAMPLE_SIZE).map((raw, i) => previewRow(raw, mapped[i], mapping, COMPANY_SLOTS)),
      warnings,
      // A company contact is nobody's relationship — there is no owner column on this side and
      // nothing for the import screen to ask for. Always zero, never "not asked".
      ownerlessRows: 0,
      scorableRows: scorableRows(mapped),
      companylessRows,
    };
  }

  /** What a Facebook friends file would import, without importing it. */
  static async previewFacebookFile(
    filePath: string,
    fileName: string,
    overrides: ColumnOverrides = {}
  ): Promise<UploadPreview> {
    const { headers, rows } = await readTable(filePath);
    const mapping = buildMapping(FACEBOOK_FIELDS, headers, rows, overrides);
    const mapped = rows.map((r) => mapFriendRow(r, mapping));
    const raws = rows.map((r) => rawRow(r, mapping));

    const warnings: string[] = [];
    if (rows.length === 0) warnings.push('This file has no friends to import.');

    /**
     * The name column is the file: without one there is nothing to import, and saying so here is
     * the difference between a caught wrong export and a table of blank rows.
     *
     * Asked ONCE — "did any name column land?" — rather than once per target, because the three
     * name slots are three ways of answering the same question and a file only has to answer it
     * once. Per target, this warned about the unlabelled `friend_name` on every bilingual file:
     * a file with `eng_name` and `thai_name` imports perfectly, and was told a column it doesn't
     * need was missing — then told to "pick the column it's in below", next to the one row that
     * deliberately offers no picker (`pickable: false`). A warning that fires on a good file and
     * names an impossible fix is how a warnings list stops being read.
     *
     * `relationship_owner` has no warning of its own for the same reason it never did: most
     * friends exports have no owner column, and the import handles that by asking for one typed
     * value rather than treating it as a fault.
     */
    const named = mapping.some((m) => m.target.startsWith('friend_name') && m.sourceColumn !== null);
    if (rows.length > 0 && !named) {
      // An instruction rather than an obituary: the same screen that shows this warning offers
      // the column list, so the file no longer has to be re-exported to fix it.
      warnings.push(
        "No column matched a friend's name — pick the column the names are in below, or this file will import nothing."
      );
    }

    warnings.push(...guessNote(mapping));

    // On the cleaned names, which is what the import's `usable` gate reads. NO usable name at all
    // is the only condition that drops a row — a friend with just one spelling imports normally
    // and may gain the other from a later file.
    const unnamed = mapped.filter((r) => !r.friend_name_en && !r.friend_name_th).length;
    if (unnamed > 0) {
      warnings.push(
        unnamed === 1
          ? '1 friend has no name and will not be imported.'
          : `${unnamed.toLocaleString()} friends have no name and will not be imported.`
      );
    }

    /**
     * Rows the file leaves without an owner — because it has no owner column at all, or because
     * that cell is blank on this row.
     *
     * Counted over the whole file rather than the sample, and returned as `ownerlessRows`: it is
     * what makes the typed "Relationship owner" required, and a required-or-not decided from ten
     * sample rows would be wrong about the rest of the file. Nameless rows are excluded because
     * they will not be imported either way — the same `usable` gate in comparisons.route.ts
     * decides both, so the screen and the import cannot disagree about which rows count.
     *
     * Those rows take the typed owner — not the uploader, and not dropped. The uploader would be
     * the worst of the three: it asserts a relationship that may not exist, and the
     * assistant-importing-for-a-salesperson case that split the two fields in the first place is
     * exactly the case where it would invent an introduction route in somebody's name. (Dropping
     * them is what happens to a NAMELESS friend, and that is a different situation: a friend with
     * no name can never be matched, while a friend with no owner can.)
     */
    const ownerlessRows = mapped.filter((r) => (r.friend_name_en || r.friend_name_th) && !r.relationship_owner).length;

    /**
     * The file names an owner, but not on every row.
     *
     * Only worth saying when the file HAS the column: a file with no owner column names nobody on
     * every row by construction, and reporting that as a per-row shortfall would describe an
     * ordinary Facebook export as a defective one. That case is the "one name for the whole
     * import" the screen already asks for in plain words.
     *
     * Said here so it is a thing agreed to rather than discovered in the roster afterwards —
     * the same job `cleaningNote` does for the names.
     */
    const ownerColumn = mapping.find((m) => m.target === 'relationship_owner')?.sourceColumn ?? null;
    if (ownerColumn && ownerlessRows > 0) {
      warnings.push(
        ownerlessRows === 1
          ? '1 friend has no relationship owner in the file — it will be filed under the owner you enter below.'
          : `${ownerlessRows.toLocaleString()} friends have no relationship owner in the file — they will be filed under the owner you enter below.`
      );
    }

    // Both spellings go through the same note: the cleaner treats them identically, and a file
    // that mangles one usually mangles the other.
    warnings.push(
      ...cleaningNote(
        (['friend_name', 'friend_name_en', 'friend_name_th'] as const).flatMap((f) =>
          raws.map(
            (raw, i) =>
              [raw[f], mapped[i].friend_name_en ?? mapped[i].friend_name_th] as [string, string | null]
          )
        )
      )
    );

    // Owners get their own note rather than joining the one above, because the sentence differs
    // on the detail that matters: an owner is cleaned but NOT lower-cased (cleanOwnerName), and
    // folding it into a note promising lower case would misdescribe the one column on this
    // screen that keeps its capitalisation.
    if (ownerColumn) {
      const changed = raws.filter(
        (raw, i) => raw.relationship_owner !== null && wasCleaned(raw.relationship_owner, mapped[i].relationship_owner)
      ).length;
      if (changed > 0) {
        warnings.push(
          changed === 1
            ? '1 relationship owner will be tidied — titles like “Khun” are removed so one person is one roster. Capitalisation is kept.'
            : `${changed.toLocaleString()} relationship owners will be tidied — titles like “Khun” are removed so one person is one roster. Capitalisation is kept.`
        );
      }
    }

    return {
      kind: 'facebook',
      fileName,
      totalRows: rows.length,
      sourceColumns: headers,
      ignoredColumns: ignoredColumns(headers, mapping),
      mapping,
      sampleRows: raws.slice(0, SAMPLE_SIZE).map((raw, i) => previewRow(raw, mapped[i], mapping, FRIEND_SLOTS)),
      warnings,
      ownerlessRows,
      scorableRows: scorableRows(mapped),
      // A friend has no company — that column belongs to the other side of the import.
      companylessRows: 0,
    };
  }
}
