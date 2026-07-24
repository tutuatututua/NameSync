import ExcelJS from 'exceljs';
import { BadRequest } from './errors';
import { assertUniqueHeaders, type Sheet } from './sheet';

/**
 * Reads a spreadsheet into headers + row objects — one of the readers behind `readTable`
 * (table-file.ts), and the shape all of them produce.
 *
 * A row is keyed by its header text, exactly as the .csv and .json readers key theirs, which is
 * what lets the column-mapping code above them be written once and stay format-blind.
 *
 * Only the first worksheet is read. A workbook whose second tab holds the real data is a
 * different file than the one the preview showed, and guessing which tab was meant is the
 * kind of cleverness that silently imports the wrong thing.
 */

/** A cell can hold rich text, a formula, a hyperlink or an error — flatten it to its text. */
function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const v = value as unknown as Record<string, unknown>;
    if ('richText' in v && Array.isArray(v.richText)) {
      return (v.richText as { text?: string }[]).map((r) => r.text ?? '').join('');
    }
    // A formula cell carries the computed value; an empty one has no `result` at all.
    if ('result' in v) return cellText(v.result as ExcelJS.CellValue);
    if ('text' in v) return String(v.text ?? '');
    if ('error' in v) return '';
    return '';
  }
  return String(value);
}

export type { Sheet };

/**
 * Read the first worksheet: row 1 is the header, the rest are data.
 *
 * Rows that are entirely empty are dropped — trailing blank rows are what a spreadsheet
 * hands you for free, and counting them would inflate every "N rows will be imported".
 */
export async function readSheet(filePath: string): Promise<Sheet> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.readFile(filePath);
  } catch {
    throw new BadRequest("That file isn't a readable .xlsx workbook.");
  }

  const sheet = workbook.worksheets[0];
  if (!sheet) throw new BadRequest('This workbook has no sheets.');

  const headerRow = sheet.getRow(1);
  const headers: string[] = [];
  // `values` is 1-based with a hole at index 0, and a header the user left blank still
  // occupies a column — keep the position so later cells line up with the right header.
  for (let c = 1; c <= sheet.columnCount; c++) {
    headers.push(cellText(headerRow.getCell(c).value).trim());
  }

  // Shared with the other readers: a repeated header is refused rather than resolved. See
  // assertUniqueHeaders (sheet.ts) for why guessing is worse than stopping.
  assertUniqueHeaders(headers);

  const rows: Record<string, string>[] = [];
  for (let r = 2; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const record: Record<string, string> = {};
    let hasValue = false;
    headers.forEach((header, i) => {
      if (!header) return; // a column with no header maps to nothing
      const text = cellText(row.getCell(i + 1).value).trim();
      if (text !== '') hasValue = true;
      record[header] = text;
    });
    if (hasValue) rows.push(record);
  }

  return { headers: headers.filter((h) => h !== ''), rows };
}
