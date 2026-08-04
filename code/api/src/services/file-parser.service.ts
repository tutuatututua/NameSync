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
}

// The language spellings mirror FACEBOOK_FIELDS below, `en_name`/`th_name` included: the two
// sides of an import come out of the same exporters, and a header vocabulary one file is allowed
// to use and the other isn't would be a difference with no reason behind it.
const COMPANY_FIELDS: FieldSpec[] = [
  { target: 'company_name', label: 'Company', aliases: ['company_name', 'Company Name', 'company'] },
  { target: 'person_name_th', label: 'Thai name', aliases: ['thai_name', 'th_name', 'Thai Name', 'thai', 'name_th'], isName: true },
  { target: 'person_name_en', label: 'English name', aliases: ['eng_name', 'en_name', 'English Name', 'English', 'eng', 'name_en'], isName: true },
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
    aliases: ['name', 'friend_name', 'Friend Name', 'Facebook Name', 'fb_name', 'full_name'],
    isName: true,
    isGeneric: true,
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
    aliases: ['friend_name_en', 'eng_name', 'en_name', 'English Name', 'name_en', 'Friend Name (English)'],
    isName: true,
  },
  {
    target: 'friend_name_th',
    label: 'Friend name (Thai)',
    aliases: ['friend_name_th', 'thai_name', 'th_name', 'Thai Name', 'thai', 'name_th', 'Friend Name (Thai)'],
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

/** Headers match ignoring case, spaces and underscores: "Thai Name" == "thai_name". */
const norm = (s: string): string => s.replace(/[\s_]+/g, '').toLowerCase();

/** The header an alias list finds in this file, or null. */
const detect = (aliases: string[], headers: string[]): string | null =>
  aliases.map((a) => headers.find((h) => norm(h) === norm(a))).find((h) => h !== undefined) ?? null;

/**
 * Resolve each target column to the header that supplies it, or null if the file has none.
 *
 * `overrides` is the user answering the question this function otherwise answers alone: a target
 * they named a column for takes that column, whatever the aliases say. It exists because an alias
 * list only knows the exports it was written against, and "not found" on the preview screen used
 * to be a dead end — the column was simply dropped and the file had to be re-exported or renamed
 * by hand.
 *
 * A named header the file does NOT have is ignored rather than honoured as null, and detection
 * runs for that target as usual. That is the file-swapped-underneath case (the UI resets its
 * choices with the file, but a scripted caller need not), and behaving as though no choice was
 * made is the only reading that can't quietly empty a column the file plainly has.
 */
function buildMapping(fields: FieldSpec[], headers: string[], overrides: ColumnOverrides = {}): ColumnMapping[] {
  return fields.map(({ target, label, aliases, isName, isOwner, isGeneric }) => {
    // Matched the same forgiving way an alias is, so a header round-tripped through a UI or a
    // hand-written script ("Thai Name" vs "thai_name") still lands on the column it names.
    // A generic slot takes detection only — the picker that would fill it isn't offered, and
    // honouring a choice nothing can make would be a second way in with no way to see it.
    const chosen = !isGeneric && overrides[target] ? detect([overrides[target]], headers) : null;
    const sourceColumn = chosen ?? detect(aliases, headers);
    return {
      target,
      label,
      sourceColumn,
      // `cleaned` tells the preview which cells have a `<target>_clean` twin to show. An owner
      // gets one too: it is cleaned (titles stripped), so the file's own spelling is worth showing
      // beside what will be stored, for the same reason a friend's name is.
      cleaned: isName === true || isOwner === true,
      pickable: isGeneric !== true,
    };
  });
}

/** Headers the file has that no target column claims — the import will ignore them. */
const ignoredColumns = (headers: string[], mapping: ColumnMapping[]): string[] => {
  const claimed = new Set(mapping.map((m) => m.sourceColumn).filter(Boolean));
  return headers.filter((h) => !claimed.has(h));
};

/** Pull one target column out of a raw row. Empty string is absence, not a value. */
const cell = (row: Record<string, unknown>, sourceColumn: string | null): string | null => {
  if (!sourceColumn) return null;
  const v = row[sourceColumn];
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

/** The raw cells a row supplies, keyed by target column — the file's own words, before cleaning.
 *  Only the preview reads this: the import stores cleaned names and nothing else. */
const rawRow = (row: Record<string, unknown>, mapping: ColumnMapping[]): Record<string, string | null> =>
  Object.fromEntries(mapping.map((m) => [m.target, cell(row, m.sourceColumn)]));

const mapCompanyRow = (row: Record<string, string>, mapping: ColumnMapping[]): CompanyContactRecord => {
  const by = (target: string) => cell(row, mapping.find((m) => m.target === target)?.sourceColumn ?? null);
  return {
    // A company name is only ever grouped and matched exactly, so it's tidied (whitespace,
    // invisible characters) but never de-titled: "Mr Pizza Co." is a company called Mr Pizza.
    company_name: tidyText(by('company_name')),
    person_name_th: cleanPersonName(by('person_name_th')),
    person_name_en: cleanPersonName(by('person_name_en')),
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
 */
function routeFriendNames(
  generic: string | null,
  en: string | null,
  th: string | null
): { friend_name_en: string | null; friend_name_th: string | null } {
  if (generic) {
    if (hasThai(generic)) th = th ?? generic;
    else en = en ?? generic;
  }
  return { friend_name_en: en, friend_name_th: th };
}

const mapFriendRow = (row: Record<string, string>, mapping: ColumnMapping[]): FriendRecord => {
  const by = (target: string) => cell(row, mapping.find((m) => m.target === target)?.sourceColumn ?? null);
  return {
    ...routeFriendNames(
      cleanPersonName(by('friend_name')),
      cleanPersonName(by('friend_name_en')),
      cleanPersonName(by('friend_name_th'))
    ),
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
  mapping: ColumnMapping[]
): Record<string, string | null> => {
  const stored = record as unknown as Record<string, string | null | undefined>;
  const out: Record<string, string | null> = {};
  for (const m of mapping) {
    if (m.cleaned) {
      // A name column: the raw cell, plus the cleaned value that will be stored beneath it.
      out[m.target] = raw[m.target] ?? null;
      // `friend_name` is the one target with no column of its own — `routeFriendNames` sends the
      // unlabelled cell to whichever language its script indicates. So the stored value is looked
      // up in the column it landed in, using the same script test that put it there. Cleaning
      // never changes a name's script, so testing the RAW cell agrees with the routing by
      // construction, and the value still comes off the record rather than being re-derived.
      out[`${m.target}_clean`] =
        m.target === 'friend_name'
          ? raw.friend_name
            ? (hasThai(raw.friend_name) ? stored.friend_name_th : stored.friend_name_en) ?? null
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
    const mapping = buildMapping(COMPANY_FIELDS, headers, overrides);
    return rows.map((r) => mapCompanyRow(r, mapping));
  }

  /** Parse a Facebook friends file into friend records. */
  static async parseFacebookFile(filePath: string, overrides: ColumnOverrides = {}): Promise<FriendRecord[]> {
    const { headers, rows } = await readTable(filePath);
    const mapping = buildMapping(FACEBOOK_FIELDS, headers, overrides);
    return rows.map((r) => mapFriendRow(r, mapping));
  }

  /** What a company file would import, without importing it. */
  static async previewCompanyFile(
    filePath: string,
    fileName: string,
    overrides: ColumnOverrides = {}
  ): Promise<UploadPreview> {
    const { headers, rows } = await readTable(filePath);
    const mapping = buildMapping(COMPANY_FIELDS, headers, overrides);
    const mapped = rows.map((r) => mapCompanyRow(r, mapping));
    const raws = rows.map((r) => rawRow(r, mapping));

    const warnings: string[] = [];
    if (rows.length === 0) warnings.push('This file has no rows to import.');

    for (const m of mapping) {
      if (!m.sourceColumn) {
        // Now an instruction rather than an obituary: the same screen that shows this warning
        // offers the column list, so the file no longer has to be re-exported to fix it.
        warnings.push(`No column matched “${m.label}” — pick the column it's in below, or it will be empty on every row.`);
      }
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
    // the number has to describe what will actually be written.
    warnings.push(
      ...cleaningNote(
        raws.flatMap((raw, i): [string | null, string | null][] => [
          [raw.person_name_th, mapped[i].person_name_th],
          [raw.person_name_en, mapped[i].person_name_en],
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
      sampleRows: raws.slice(0, SAMPLE_SIZE).map((raw, i) => previewRow(raw, mapped[i], mapping)),
      warnings,
      // A company contact is nobody's relationship — there is no owner column on this side and
      // nothing for the import screen to ask for. Always zero, never "not asked".
      ownerlessRows: 0,
    };
  }

  /** What a Facebook friends file would import, without importing it. */
  static async previewFacebookFile(
    filePath: string,
    fileName: string,
    overrides: ColumnOverrides = {}
  ): Promise<UploadPreview> {
    const { headers, rows } = await readTable(filePath);
    const mapping = buildMapping(FACEBOOK_FIELDS, headers, overrides);
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
      sampleRows: raws.slice(0, SAMPLE_SIZE).map((raw, i) => previewRow(raw, mapped[i], mapping)),
      warnings,
      ownerlessRows,
    };
  }
}
