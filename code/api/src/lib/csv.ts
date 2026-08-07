import fs from 'fs';
import { BadRequest } from './errors';
import { assertUniqueHeaders, findHeaderRow, type Sheet } from './sheet';

/**
 * Reads a delimited text file (.csv) into the same headers + rows a workbook reads into.
 *
 * Written by hand rather than pulled in as a dependency, because the whole job is one loop and a
 * quote state: the file is small, it arrives from a spreadsheet export, and the only case that
 * really has to work is a comma (or a name) inside a quoted cell — `"Acme, Inc."`.
 *
 * Row 1 is the header, like every other reader here. A file whose first line is data will import
 * its first row as column names, which is what the preview screen is for.
 */

/** Excel writes the separator its locale uses, and a Thai/European export is as likely to be
 *  semicolon- or tab-delimited as comma. Sniffed from the header line rather than configured:
 *  the file already says which one it used, and asking the user would be asking them to know. */
const DELIMITERS = [',', ';', '\t'] as const;

/**
 * Decode the file's bytes.
 *
 * A UTF-16 BOM is honoured because "Unicode text" is one of Excel's own Save-As formats and reading
 * those bytes as UTF-8 yields a column of NUL-separated garbage rather than a readable failure. A
 * UTF-8 BOM is stripped — left in place it becomes part of the first header ("﻿company_name"),
 * which matches no alias and silently loses the first column.
 */
function decode(buffer: Buffer): string {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString('utf16le');
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    // Big-endian: swap to LE in place, then decode. Node has no utf16be decoder.
    const swapped = Buffer.from(buffer.subarray(2));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  return buffer.toString('utf8').replace(/^﻿/, '');
}

/** How many lines the delimiter sniff reads. It used to read one — the first — which is the wrong
 *  line in a file that opens with a preamble (see `findHeaderRow`): a prose line has no separator
 *  in it at all, so a semicolon-delimited LinkedIn export would have been read as one column. */
const SNIFF_LINES = 25;

/** Which delimiter this file uses: the one that yields the most cells on any of the first lines.
 *  Ties go to the earlier candidate, so a plain comma file is never read as anything else. */
function sniffDelimiter(text: string): string {
  const lines = firstLines(text, SNIFF_LINES);
  const widest = (d: string) => Math.max(...lines.map((l) => splitLine(l, d).length));

  let best: string = DELIMITERS[0];
  let bestCount = widest(DELIMITERS[0]);
  for (const d of DELIMITERS.slice(1)) {
    const count = widest(d);
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

/** The first `limit` lines, respecting quotes — a quoted cell may hold a newline, and the sniff
 *  must not cut a line in half at one. */
function firstLines(text: string, limit: number): string[] {
  const lines: string[] = [];
  let quoted = false;
  let start = 0;
  for (let i = 0; i < text.length && lines.length < limit; i++) {
    const c = text[i];
    if (c === '"') quoted = !quoted;
    else if (!quoted && (c === '\n' || c === '\r')) {
      lines.push(text.slice(start, i));
      if (c === '\r' && text[i + 1] === '\n') i++;
      start = i + 1;
    }
  }
  if (lines.length < limit && start < text.length) lines.push(text.slice(start));
  return lines.length > 0 ? lines : [text];
}

/** One line into cells. Only used for the delimiter sniff; the real parse is `parseRows`. */
function splitLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === delimiter) {
      cells.push(cell);
      cell = '';
    } else cell += c;
  }
  cells.push(cell);
  return cells;
}

/**
 * The whole file into rows of cells.
 *
 * A newline inside quotes is data, not a row break — a pasted address or a multi-line note is
 * ordinary in an export, and splitting on it would shear one row into two half-rows and shift every
 * column after it. CRLF is normalised as it goes, so a Windows export and a Unix one read alike.
 */
function parseRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
      continue;
    }

    if (c === '"') quoted = true;
    else if (c === delimiter) {
      cells.push(cell);
      cell = '';
    } else if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      cells.push(cell);
      rows.push(cells);
      cells = [];
      cell = '';
    } else cell += c;
  }

  // The last row, when the file does not end in a newline.
  if (cell !== '' || cells.length > 0) {
    cells.push(cell);
    rows.push(cells);
  }
  return rows;
}

/**
 * Read a .csv: the header row, then the data under it.
 *
 * Usually that is row 1, but not always — see `findHeaderRow`, which steps over the `Notes:`
 * preamble a LinkedIn export opens with. Everything above the header is dropped: it is prose
 * about the file, not rows of it.
 *
 * Rows that are entirely empty are dropped, exactly as the workbook reader drops them — a trailing
 * blank line is what a text editor hands you for free, and counting it would inflate every
 * "N rows will be imported".
 */
export async function readCsv(filePath: string): Promise<Sheet> {
  let text: string;
  try {
    text = decode(await fs.promises.readFile(filePath));
  } catch {
    throw new BadRequest("That file couldn't be read as text.");
  }

  if (text.trim() === '') throw new BadRequest('This CSV file is empty.');

  const delimiter = sniffDelimiter(text);
  const grid = parseRows(text, delimiter);
  const [headerCells = [], ...body] = grid.slice(findHeaderRow(grid));

  // A blank header still occupies a column — keep the position so later cells line up with the
  // right header, then drop the blanks from the reported header list.
  const headers = headerCells.map((h) => h.trim());
  assertUniqueHeaders(headers);

  const rows: Record<string, string>[] = [];
  for (const line of body) {
    const record: Record<string, string> = {};
    let hasValue = false;
    headers.forEach((header, i) => {
      if (!header) return; // a column with no header maps to nothing
      const text = (line[i] ?? '').trim();
      if (text !== '') hasValue = true;
      record[header] = text;
    });
    if (hasValue) rows.push(record);
  }

  return { headers: headers.filter((h) => h !== ''), rows };
}
