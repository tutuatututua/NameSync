import type { ColumnMapping, UploadPreview } from '@extensions/contract';
import type { CompanyContactRecord } from '../models/company-contact.model';
import type { FriendRecord } from '../models/friend.model';
import { readTable } from '../lib/table-file';
import { cleanPersonName, tidyText, wasCleaned } from './name-cleaner.service';

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
}

const COMPANY_FIELDS: FieldSpec[] = [
  { target: 'company_name', label: 'Company', aliases: ['company_name', 'Company Name', 'company'] },
  { target: 'person_name_th', label: 'Thai name', aliases: ['thai_name', 'Thai Name', 'thai'], isName: true },
  { target: 'person_name_en', label: 'English name', aliases: ['eng_name', 'English Name', 'English', 'eng'], isName: true },
];

/** Facebook friends, as a table. The JSON export's own key name (`name`) leads the aliases: it is
 *  what that export writes, and what a workbook made by pasting it in keeps.
 *
 *  The export's `timestamp` ("friended on") used to be read into `friend.source_timestamp`.
 *  Nothing ever matched, grouped or filtered on it — it only ordered the grid — so the column
 *  is gone and the header is now simply one of the ones this file ignores. */
const FACEBOOK_FIELDS: FieldSpec[] = [
  {
    target: 'friend_name',
    label: 'Facebook name',
    aliases: ['name', 'friend_name', 'Friend Name', 'Facebook Name', 'fb_name', 'full_name'],
    isName: true,
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

/** Resolve each target column to the header that supplies it, or null if the file has none. */
function buildMapping(fields: FieldSpec[], headers: string[]): ColumnMapping[] {
  return fields.map(({ target, label, aliases, isName }) => {
    const sourceColumn =
      aliases.map((a) => headers.find((h) => norm(h) === norm(a))).find((h) => h !== undefined) ?? null;
    // `cleaned` tells the preview which cells have a `<target>_clean` twin to show.
    return { target, label, sourceColumn, cleaned: isName === true };
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

const mapFriendRow = (row: Record<string, string>, mapping: ColumnMapping[]): FriendRecord => {
  const by = (target: string) => cell(row, mapping.find((m) => m.target === target)?.sourceColumn ?? null);
  return { friend_name: cleanPersonName(by('friend_name')) };
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
      out[`${m.target}_clean`] = stored[m.target] ?? null;
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
        ? '1 name will be cleaned — titles, suffixes and nicknames are removed and the name is stored in lower case. The original text is not kept, so check it here.'
        : `${changed.toLocaleString()} names will be cleaned — titles, suffixes and nicknames are removed and names are stored in lower case. The original text is not kept, so check them here.`
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
  /** Parse a company file into contact records. */
  static async parseCompanyFile(filePath: string): Promise<CompanyContactRecord[]> {
    const { headers, rows } = await readTable(filePath);
    const mapping = buildMapping(COMPANY_FIELDS, headers);
    return rows.map((r) => mapCompanyRow(r, mapping));
  }

  /** Parse a Facebook friends file into friend records. */
  static async parseFacebookFile(filePath: string): Promise<FriendRecord[]> {
    const { headers, rows } = await readTable(filePath);
    const mapping = buildMapping(FACEBOOK_FIELDS, headers);
    return rows.map((r) => mapFriendRow(r, mapping));
  }

  /** What a company file would import, without importing it. */
  static async previewCompanyFile(filePath: string, fileName: string): Promise<UploadPreview> {
    const { headers, rows } = await readTable(filePath);
    const mapping = buildMapping(COMPANY_FIELDS, headers);
    const mapped = rows.map((r) => mapCompanyRow(r, mapping));
    const raws = rows.map((r) => rawRow(r, mapping));

    const warnings: string[] = [];
    if (rows.length === 0) warnings.push('This file has no rows to import.');

    for (const m of mapping) {
      if (!m.sourceColumn) {
        warnings.push(`No column matched “${m.label}” — it will be empty on every row.`);
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
    };
  }

  /** What a Facebook friends file would import, without importing it. */
  static async previewFacebookFile(filePath: string, fileName: string): Promise<UploadPreview> {
    const { headers, rows } = await readTable(filePath);
    const mapping = buildMapping(FACEBOOK_FIELDS, headers);
    const mapped = rows.map((r) => mapFriendRow(r, mapping));
    const raws = rows.map((r) => rawRow(r, mapping));

    const warnings: string[] = [];
    if (rows.length === 0) warnings.push('This file has no friends to import.');

    // The name column is the file: without it there is nothing to import, and saying so here
    // is the difference between a caught wrong export and a table of blank rows.
    for (const m of mapping) {
      if (!m.sourceColumn) {
        warnings.push(`No column matched “${m.label}” — it will be empty on every row.`);
      }
    }

    // On the cleaned name, which is what the import's `usable` gate reads.
    const unnamed = mapped.filter((r) => !r.friend_name).length;
    if (unnamed > 0) {
      warnings.push(
        unnamed === 1
          ? '1 friend has no name and will not be imported.'
          : `${unnamed.toLocaleString()} friends have no name and will not be imported.`
      );
    }

    warnings.push(...cleaningNote(raws.map((raw, i) => [raw.friend_name, mapped[i].friend_name])));

    return {
      kind: 'facebook',
      fileName,
      totalRows: rows.length,
      sourceColumns: headers,
      ignoredColumns: ignoredColumns(headers, mapping),
      mapping,
      sampleRows: raws.slice(0, SAMPLE_SIZE).map((raw, i) => previewRow(raw, mapped[i], mapping)),
      warnings,
    };
  }
}
