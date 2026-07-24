import { BadRequest } from './errors';

/**
 * The one shape every upload reader produces — headers, and rows keyed by header text.
 *
 * A workbook, a CSV and a JSON array are three ways of writing down the same table, so they are
 * read into one structure and the column-mapping code above them (file-parser.service.ts) never
 * learns which one it got. That is the whole point of this module existing: adding a format is a
 * new reader, not a new branch through the import.
 */
export interface Sheet {
  /** Header texts, in column order, as the file writes them. */
  headers: string[];
  /** One object per data row, keyed by header. */
  rows: Record<string, string>[];
}

/**
 * Two columns under one header is refused, not resolved.
 *
 * A row is keyed by header text, so a repeat silently overwrites: the earlier column's data
 * vanishes, and — worse — the mapping resolves to the FIRST such header while the row object holds
 * the LAST one's values, so the preview shows one column and the import reads another. Which of the
 * two was meant is not knowable here, and a wrong guess imports the wrong column under a preview
 * that agreed with it.
 *
 * Blank headers are exempt: they are absent columns, not a repeated name, and no row keys on them.
 */
export function assertUniqueHeaders(headers: string[]): void {
  const duplicates = [
    ...new Set(headers.filter((h) => h !== '').filter((h, i, all) => all.indexOf(h) !== i)),
  ];
  if (duplicates.length === 0) return;

  const named = duplicates.map((h) => `“${h}”`).join(', ');
  throw new BadRequest(
    duplicates.length === 1
      ? `Two columns share the header ${named}. Rename or remove one so it's clear which to import.`
      : `Several columns share headers: ${named}. Rename or remove the duplicates so it's clear which to import.`
  );
}
