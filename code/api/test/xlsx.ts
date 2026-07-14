import ExcelJS from "exceljs";

/**
 * Workbook fixtures. Uploads are .xlsx now, so a test that wants to import two names has to
 * hand the API real spreadsheet bytes — there is no shorter honest way in.
 *
 * The rows are still written here as CSV text, because that is what a test is actually
 * saying ("these headers, these two rows") and a workbook literal would bury it.
 */

/** A workbook with one sheet: `headers` on row 1, `rows` under it. */
export async function xlsxBuffer(headers: string[], rows: (string | number | null)[][]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");
  sheet.addRow(headers);
  for (const row of rows) sheet.addRow(row);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** Turn CSV text into the workbook it describes. Quoted fields (`"Acme, Inc."`) are honoured
 *  — a comma inside a cell is exactly the case that has to keep working. */
export async function csvToXlsx(csv: string): Promise<Buffer> {
  const lines = csv.replace(/^﻿/, "").split("\n").filter((l) => l.trim() !== "");
  const [header, ...body] = lines.map(splitCsvLine);
  return xlsxBuffer(header ?? [], body);
}

/** A Facebook friends workbook: the export's own column names, and its Unix-seconds clock. */
export function friendsXlsx(friends: [name: string, timestamp: number][]): Promise<Buffer> {
  return xlsxBuffer(["name", "timestamp"], friends.map(([name, timestamp]) => [name, timestamp]));
}

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        cell += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      cells.push(cell);
      cell = "";
    } else if (c !== "\r") {
      cell += c;
    }
  }
  cells.push(cell);
  return cells;
}
