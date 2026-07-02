export interface FileRule {
  /** Accepted extensions, lowercase incl. dot, e.g. [".csv"]. */
  accept: string[];
  maxSizeMB?: number;
}

/** Returns an error message, or null when the file is acceptable. */
export function validateFile(file: File, rule: FileRule): string | null {
  const name = file.name.toLowerCase();
  if (!rule.accept.some((ext) => name.endsWith(ext))) {
    return `File must be ${rule.accept.join(" or ")}`;
  }
  if (rule.maxSizeMB && file.size > rule.maxSizeMB * 1024 * 1024) {
    return `File exceeds the ${rule.maxSizeMB} MB limit`;
  }
  return null;
}
