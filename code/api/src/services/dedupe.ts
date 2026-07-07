import { CompanyDataModel } from "../models/company-data.model";
import { FacebookDataModel } from "../models/facebook-data.model";
import { CompanyDataRecord, FacebookDataRecord } from "./file-parser.service";

/**
 * Merge/continue semantics. company_data and facebook_data are cumulative, global
 * tables (dedupe and the webhook forward span all sessions), so "merging" a new
 * upload means: add only rows not already present. Both fresh `create` and
 * `merge`/continue run these helpers, so a continue-upload genuinely builds on the
 * existing dataset instead of re-inserting rows or throwing on duplicates.
 */

const normalizeKey = (value: string | null | undefined): string =>
  (value ?? "").trim().toLowerCase();

/** Company rows not already in the DB, dropping intra-file repeats (keep first). */
export async function dedupeCompany(records: CompanyDataRecord[]): Promise<CompanyDataRecord[]> {
  if (records.length === 0) return records;
  const existing = new Set(
    (await CompanyDataModel.getExistingKeys()).map(
      (k) => `${normalizeKey(k.company_name)}|${normalizeKey(k.person_name_th)}`
    )
  );
  const seen = new Set<string>();
  return records.filter((r) => {
    const key = `${normalizeKey(r.company_name)}|${normalizeKey(r.person_name_th)}`;
    if (key === "|") return true; // no usable key — can't dedupe, keep it
    if (existing.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Facebook rows whose fb_name is not already in the DB, dropping intra-file repeats. */
export async function dedupeFacebook(records: FacebookDataRecord[]): Promise<FacebookDataRecord[]> {
  if (records.length === 0) return records;
  const existing = new Set((await FacebookDataModel.getExistingFbNames()).map(normalizeKey));
  const seen = new Set<string>();
  return records.filter((r) => {
    const key = normalizeKey(r.fb_name);
    if (key === "") return true; // no usable name — keep it
    if (existing.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
