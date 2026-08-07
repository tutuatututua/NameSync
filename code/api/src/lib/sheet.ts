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

/** How far into a file the header row is looked for. A preamble is a few lines of prose, never
 *  a chapter — and past this the cost of guessing wrong outweighs the file it would rescue. */
const HEADER_SCAN = 25;

/**
 * Which row holds the column names — usually the first, and not always.
 *
 * "Row 1 is the header" is what every reader here assumed, and it is wrong for one very common
 * export: LinkedIn's `Connections.csv` opens with a `Notes:` line, a paragraph of prose and a
 * blank line before the real header. Read from row 1, that file has exactly one column called
 * "Notes:" — so every column it actually has is invisible, nothing can be detected, and the
 * preview's picker has nothing to offer either. The report that prompted this ("the column is
 * not there, so I can't select it") is that file.
 *
 * The signal is deliberately narrow, because getting this wrong silently imports the wrong row
 * as column names. A row is skipped only when it is BLANK or holds a SINGLE value — prose has
 * no delimiters, a header row has several — and only when a later row in the window has at
 * least two values AND is itself followed by another row, i.e. looks like a header with data
 * under it. A file whose first row genuinely holds one header (the rest blank) has no such
 * "later, wider row followed by more", so it keeps row 1 and behaves exactly as it always did.
 *
 * Returns an index into `grid`. Zero — the old behaviour — whenever the shape is anything but
 * the one described above.
 */
export function findHeaderRow(grid: string[][]): number {
  const filled = grid.slice(0, HEADER_SCAN).map((row) => row.filter((c) => c.trim() !== '').length);

  // The first row that looks like a header: two or more values, with at least one row beneath it.
  const header = filled.findIndex((n, i) => n >= 2 && i + 1 < grid.length);

  // Nothing header-shaped in the window (a single-column file, or one row of data): the first row
  // with anything in it at all, so leading blank lines are still stepped over.
  if (header <= 0) {
    const first = filled.findIndex((n) => n > 0);
    return first === -1 ? 0 : first;
  }

  // Everything above it has to look like preamble. If it doesn't, the wider row further down is
  // ragged data rather than a header, and row 1 was right after all.
  return filled.slice(0, header).every((n) => n <= 1) ? header : 0;
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
