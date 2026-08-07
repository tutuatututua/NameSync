import fs from 'fs';
import { BadRequest } from './errors';
import type { Sheet } from './sheet';

/**
 * Reads a .json export into the same headers + rows a workbook reads into.
 *
 * The shape this expects is the shape an export actually has: a list of records. Facebook's own
 * friends download is `{"friends_v2": [{"name": …, "timestamp": …}]}`, and a hand-made file is
 * usually the bare array — both are read here, so the user is not asked to reshape their download
 * into a spreadsheet before importing it.
 *
 * The columns are the keys, so the SAME column mapping that reads a workbook reads this: a JSON
 * `name` field and an .xlsx `name` column are one column to everything downstream.
 */

/** Where a wrapped export keeps its records. Tried in order, before falling back to "the only array
 *  property there is" — the fallback is what makes an unknown export work, and the list is what
 *  stops a file with several arrays being guessed about. */
const RECORD_KEYS = ['friends_v2', 'friends', 'data', 'rows', 'records', 'items', 'results'];

/** A JSON value that is a cell: something with one obvious text form. A nested object is not one —
 *  it is a group of cells, and `flatten` below unpacks it into its own columns. */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return '';
  return String(value);
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** How deep nesting is unpacked. Deep enough for the shapes exports actually have
 *  (`profile.name`, `contact.owner.name`), bounded so a pathological file can't fan out. */
const FLATTEN_DEPTH = 4;

/**
 * A nested record, unpacked into dotted columns: `{profile: {name: "…"}}` becomes `profile.name`.
 *
 * This module used to read an object-valued key as an empty cell, on the argument that flattening
 * "would invent a column the file never had". That was the wrong call, and it is the JSON half of
 * the bug this fixes: a file whose name sits one level down had no column holding it — so nothing
 * could detect it and, worse, the preview's picker had nothing to offer either. The key is right
 * there in the file; the reader was the only thing that couldn't see it. A dotted name says exactly
 * where the value came from, so nothing is invented — the path is the column's name.
 *
 * An ARRAY of scalars is joined (`["a","b"]` → `a, b`) because a list of tags or aliases has one
 * obvious text form. An array of objects is left alone: it is a table inside a row, and there is no
 * honest column to make of it.
 */
function flatten(record: Record<string, unknown>, prefix = '', depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key.trim() === '') continue;
    const name = prefix ? `${prefix}.${key}` : key;

    if (isRecord(value) && depth < FLATTEN_DEPTH) {
      Object.assign(out, flatten(value, name, depth + 1));
      continue;
    }
    if (Array.isArray(value) && value.every((v) => v !== null && typeof v !== 'object')) {
      out[name] = value.join(', ');
      continue;
    }
    out[name] = value;
  }
  return out;
}

/** Pull the list of records out of whatever the file's top level is. */
function findRecords(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;

  if (isRecord(parsed)) {
    for (const key of RECORD_KEYS) {
      if (Array.isArray(parsed[key])) return parsed[key] as unknown[];
    }
    const arrayKeys = Object.keys(parsed).filter((k) => Array.isArray(parsed[k]));
    if (arrayKeys.length === 1) return parsed[arrayKeys[0]] as unknown[];
    if (arrayKeys.length > 1) {
      throw new BadRequest(
        `This JSON file has several lists (${arrayKeys.map((k) => `“${k}”`).join(', ')}) and it isn't clear which holds the records. Upload the list itself, or name it “data”.`
      );
    }
  }

  throw new BadRequest(
    'This JSON file is not a list of records. Expected an array of objects, or an object with the array under a key like “data” or “friends”.'
  );
}

/**
 * Read a .json file: one object per row, its keys the columns.
 *
 * A list of bare strings is read as a single `name` column — that is what a pasted friend list
 * looks like, and the alternative is refusing a file whose meaning is not in doubt. The preview
 * shows the column it invented, so the guess is visible before anything is written.
 *
 * Rows whose every cell is empty are dropped, as in the other readers.
 */
export async function readJsonRows(filePath: string): Promise<Sheet> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
  } catch {
    throw new BadRequest("That file isn't readable JSON.");
  }

  const records = findRecords(parsed);

  // A list of names rather than of records.
  const scalarList = records.length > 0 && records.every((r) => r !== null && typeof r !== 'object');
  if (scalarList) {
    const rows = records
      .map((r) => ({ name: String(r).trim() }))
      .filter((r) => r.name !== '');
    return { headers: ['name'], rows };
  }

  const nonRecord = records.find((r) => !isRecord(r));
  if (nonRecord !== undefined) {
    throw new BadRequest('This JSON file mixes records with other values — every entry in the list must be an object.');
  }

  // Flattened first, so a nested key is a column like any other — see `flatten`.
  const flat = (records as Record<string, unknown>[]).map((r) => flatten(r));

  // Columns are the union of the keys, in the order the file first uses them: a record that omits
  // an optional field must not drop that column for everybody else.
  const headers: string[] = [];
  for (const record of flat) {
    for (const key of Object.keys(record)) {
      if (!headers.includes(key)) headers.push(key);
    }
  }

  const rows: Record<string, string>[] = [];
  for (const record of flat) {
    const row: Record<string, string> = {};
    let hasValue = false;
    for (const header of headers) {
      const text = cellText(record[header]).trim();
      if (text !== '') hasValue = true;
      row[header] = text;
    }
    if (hasValue) rows.push(row);
  }

  return { headers, rows };
}
