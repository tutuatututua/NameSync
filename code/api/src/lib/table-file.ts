import path from 'path';
import { BadRequest } from './errors';
import type { Sheet } from './sheet';
import { readSheet } from './xlsx';
import { readCsv } from './csv';
import { readJsonRows } from './json-rows';

/**
 * One door into every upload format this app accepts.
 *
 * A company export and a friends export are tables however they were written down, so the format is
 * decided here — once — and everything above this (`file-parser.service.ts`, the preview, the
 * import) reads a `Sheet` and never learns whether it came from a workbook, a CSV or a JSON list.
 * Adding a format is a reader plus a line in `READERS`.
 *
 * The extension decides, not the bytes: a file named `.csv` that holds a workbook is a mislabelled
 * file, and guessing past the name is how a preview ends up describing a different file than the
 * import reads. Whether the bytes really are what the extension claims is the reader's question,
 * and each one answers it with its own BadRequest.
 */

const READERS: Record<string, (filePath: string) => Promise<Sheet>> = {
  '.xlsx': readSheet,
  '.csv': readCsv,
  '.json': readJsonRows,
};

/** The accepted extensions, lower-case and dotted — the same list the browser's file picker and the
 *  multipart intake filter on, so the three cannot drift apart. */
export const UPLOAD_EXTENSIONS = Object.keys(READERS);

/** How the accepted formats are named to a user: ".xlsx, .csv or .json". */
export const UPLOAD_FORMATS = `${UPLOAD_EXTENSIONS.slice(0, -1).join(', ')} or ${UPLOAD_EXTENSIONS.at(-1)}`;

/** Does this filename claim a format we can read? */
export const isSupportedUpload = (fileName: string): boolean =>
  UPLOAD_EXTENSIONS.includes(path.extname(fileName).toLowerCase());

/** Read an upload into headers + rows, whichever of the accepted formats it is written in. */
export function readTable(filePath: string): Promise<Sheet> {
  const reader = READERS[path.extname(filePath).toLowerCase()];
  if (!reader) throw new BadRequest(`That file type can't be imported — upload ${UPLOAD_FORMATS}.`);
  return reader(filePath);
}
