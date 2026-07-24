/**
 * The formats an import accepts, as the file picker spells them.
 *
 * The same three the API's reader registry knows (`api/src/lib/table-file.ts`): a workbook, a CSV
 * or a JSON export, for either source. Kept in one constant so a drop zone, its `<input accept>`
 * and the error message beneath it cannot disagree about what may be dropped.
 */
export const UPLOAD_ACCEPT = [".xlsx", ".csv", ".json"] as const;

/** ".xlsx, .csv or .json" — the accepted formats in a sentence. */
export function listFormats(accept: readonly string[]): string {
  if (accept.length <= 1) return accept[0] ?? "";
  return `${accept.slice(0, -1).join(", ")} or ${accept[accept.length - 1]}`;
}

export interface FileRule {
  /** Accepted extensions, lowercase incl. dot, e.g. [".csv"]. */
  accept: readonly string[];
  maxSizeMB?: number;
}

/** Returns an error message, or null when the file is acceptable. */
export function validateFile(file: File, rule: FileRule): string | null {
  const name = file.name.toLowerCase();
  if (!rule.accept.some((ext) => name.endsWith(ext))) {
    return `File must be ${listFormats(rule.accept)}`;
  }
  if (rule.maxSizeMB && file.size > rule.maxSizeMB * 1024 * 1024) {
    return `File exceeds the ${rule.maxSizeMB} MB limit`;
  }
  return null;
}
