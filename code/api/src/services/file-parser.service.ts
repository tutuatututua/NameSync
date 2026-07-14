import type { ColumnMapping, UploadPreview } from '@extensions/contract';
import type { CompanyContactRecord } from '../models/company-contact.model';
import type { FriendRecord } from '../models/friend.model';
import { readSheet } from '../lib/xlsx';
import { cleanPersonName, tidyText, wasCleaned } from './name-cleaner.service';

/**
 * Reads the files this app accepts — an .xlsx workbook, for both sources — and describes
 * what it read.
 *
 * `parse*` is what the import runs; `preview*` is what the upload screen shows beforehand.
 * They resolve headers and map rows through the *same* functions (`buildMapping`,
 * `mapCompanyRow`), so the preview cannot promise a column the import won't fill. That
 * shared path is the whole point — a preview that disagrees with the import is worse than
 * none, because it's believed.
 *
 * Every person's name is also cleaned here (name-cleaner.service.ts) — the record carries
 * both the raw name and the cleaned one, and both are stored. Cleaning at parse time is
 * what lets the preview show exactly the cleaned values the import will write, rather than
 * showing the raw file and quietly changing it afterwards.
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

/** Facebook friends, as a sheet. The JSON export's own key names (`name`, `timestamp`) lead
 *  the aliases, because a workbook made by pasting that export in keeps them. */
const FACEBOOK_FIELDS: FieldSpec[] = [
  {
    target: 'friend_name',
    label: 'Facebook name',
    aliases: ['name', 'friend_name', 'Friend Name', 'Facebook Name', 'fb_name', 'full_name'],
    isName: true,
  },
  {
    target: 'source_timestamp',
    label: 'Added',
    aliases: ['timestamp', 'source_timestamp', 'added', 'Added On', 'date'],
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

/**
 * The "Added" column, whatever the sheet chose to put in it.
 *
 * Facebook's export counts in Unix *seconds*, and a workbook built from it usually still
 * holds that number. A date-formatted cell instead arrives as a real date (the reader hands
 * it over as ISO). Anything else that a Date can read — "2023-11-14" — is taken at face
 * value; anything it can't is dropped rather than stored as an epoch-zero lie.
 */
function toTimestamp(value: string | null): string | null {
  if (!value) return null;

  if (/^\d+$/.test(value)) {
    const n = Number(value);
    // Milliseconds only if the number is far too large to be seconds (year ~5138 upwards).
    const ms = n > 1e11 ? n : n * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const mapCompanyRow = (row: Record<string, string>, mapping: ColumnMapping[]): CompanyContactRecord => {
  const by = (target: string) => cell(row, mapping.find((m) => m.target === target)?.sourceColumn ?? null);
  const th = by('person_name_th');
  const en = by('person_name_en');
  return {
    // A company name is only ever grouped and matched exactly, so it's tidied (whitespace,
    // invisible characters) but never de-titled: "Mr Pizza Co." is a company called Mr Pizza.
    company_name: tidyText(by('company_name')),
    person_name_th: th,
    person_name_th_clean: cleanPersonName(th),
    person_name_en: en,
    person_name_en_clean: cleanPersonName(en),
  };
};

const mapFriendRow = (row: Record<string, string>, mapping: ColumnMapping[]): FriendRecord => {
  const by = (target: string) => cell(row, mapping.find((m) => m.target === target)?.sourceColumn ?? null);
  const name = by('friend_name');
  return {
    friend_name: name,
    friend_name_clean: cleanPersonName(name),
    source_timestamp: toTimestamp(by('source_timestamp')),
  };
};

/** "3 names were tidied…" — the preview's account of what cleaning will do to this file, so
 *  it's a thing you agreed to rather than a thing you discover in the grid afterwards. */
function cleaningNote(pairs: [raw: string | null, clean: string | null][]): string | null {
  const changed = pairs.filter(([raw, clean]) => raw !== null && wasCleaned(raw, clean)).length;
  if (changed === 0) return null;
  return changed === 1
    ? '1 name will be cleaned — titles, suffixes, nicknames and middle names are removed. The original is kept.'
    : `${changed.toLocaleString()} names will be cleaned — titles, suffixes, nicknames and middle names are removed. The originals are kept.`;
}

export class FileParserService {
  /** Parse a company workbook into contact records. */
  static async parseCompanyXLSX(filePath: string): Promise<CompanyContactRecord[]> {
    const { headers, rows } = await readSheet(filePath);
    const mapping = buildMapping(COMPANY_FIELDS, headers);
    return rows.map((r) => mapCompanyRow(r, mapping));
  }

  /** Parse a Facebook friends workbook into friend records. */
  static async parseFacebookXLSX(filePath: string): Promise<FriendRecord[]> {
    const { headers, rows } = await readSheet(filePath);
    const mapping = buildMapping(FACEBOOK_FIELDS, headers);
    return rows.map((r) => mapFriendRow(r, mapping));
  }

  /** What a company workbook would import, without importing it. */
  static async previewCompanyXLSX(filePath: string, fileName: string): Promise<UploadPreview> {
    const { headers, rows } = await readSheet(filePath);
    const mapping = buildMapping(COMPANY_FIELDS, headers);
    const mapped = rows.map((r) => mapCompanyRow(r, mapping));

    const warnings: string[] = [];
    if (rows.length === 0) warnings.push('This file has no rows to import.');

    for (const m of mapping) {
      if (!m.sourceColumn) {
        warnings.push(`No column matched “${m.label}” — it will be empty on every row.`);
      }
    }

    const blank = mapped.filter((r) => !r.company_name && !r.person_name_th && !r.person_name_en).length;
    if (blank > 0) {
      warnings.push(
        blank === 1
          ? '1 row has no company or person name.'
          : `${blank.toLocaleString()} rows have no company or person name.`
      );
    }

    // Counted across the whole file, not just the sample — the sample is what you see, but
    // the number has to describe what will actually be written.
    const note = cleaningNote(
      mapped.flatMap((r): [string | null, string | null][] => [
        [r.person_name_th, r.person_name_th_clean],
        [r.person_name_en, r.person_name_en_clean],
      ])
    );
    if (note) warnings.push(note);

    return {
      kind: 'company',
      fileName,
      totalRows: rows.length,
      sourceColumns: headers,
      ignoredColumns: ignoredColumns(headers, mapping),
      mapping,
      sampleRows: mapped.slice(0, SAMPLE_SIZE).map((r) => ({ ...r })),
      warnings,
    };
  }

  /** What a Facebook friends workbook would import, without importing it. */
  static async previewFacebookXLSX(filePath: string, fileName: string): Promise<UploadPreview> {
    const { headers, rows } = await readSheet(filePath);
    const mapping = buildMapping(FACEBOOK_FIELDS, headers);
    const mapped = rows.map((r) => mapFriendRow(r, mapping));

    const warnings: string[] = [];
    if (rows.length === 0) warnings.push('This file has no friends to import.');

    // The name column is the file: without it there is nothing to import, and saying so here
    // is the difference between a caught wrong export and a table of blank rows.
    for (const m of mapping) {
      if (!m.sourceColumn) {
        warnings.push(`No column matched “${m.label}” — it will be empty on every row.`);
      }
    }

    const unnamed = mapped.filter((r) => !r.friend_name).length;
    if (unnamed > 0) {
      warnings.push(
        unnamed === 1 ? '1 friend has no name.' : `${unnamed.toLocaleString()} friends have no name.`
      );
    }

    const note = cleaningNote(mapped.map((r) => [r.friend_name, r.friend_name_clean ?? null]));
    if (note) warnings.push(note);

    return {
      kind: 'facebook',
      fileName,
      totalRows: rows.length,
      sourceColumns: headers,
      ignoredColumns: ignoredColumns(headers, mapping),
      mapping,
      // Spelled out rather than spread: `source_timestamp` is optional on the record, and
      // the preview's rows are `string | null` — never `undefined`.
      sampleRows: mapped.slice(0, SAMPLE_SIZE).map((r) => ({
        friend_name: r.friend_name,
        friend_name_clean: r.friend_name_clean ?? null,
        source_timestamp: r.source_timestamp ?? null,
      })),
      warnings,
    };
  }
}
