import { CompanyDataRecord, FacebookDataRecord } from "./file-parser.service";

/**
 * Forwards CSV payloads to the external ingestion webhooks. Uses Node 20's global
 * fetch/FormData/Blob (no node-fetch / form-data). Field name `file`, `text/csv`,
 * with an X-Session-ID header — matching what the external service expects.
 */
export class WebhookService {
  static recordsToCSV(records: Record<string, unknown>[], columns: string[]): string {
    if (records.length === 0) return "";
    const header = columns.join(",");
    const rows = records.map((record) =>
      columns
        .map((col) => {
          const value = record[col];
          if (value === null || value === undefined) return "";
          const str = String(value);
          if (str.includes(",") || str.includes('"') || str.includes("\n")) {
            return `"${str.replace(/"/g, '""')}"`;
          }
          return str;
        })
        .join(",")
    );
    return [header, ...rows].join("\n");
  }

  private static async post(url: string, csv: string, sessionId: string, filename: string): Promise<boolean> {
    const form = new FormData();
    form.append("file", new Blob([csv], { type: "text/csv" }), filename);
    const res = await fetch(url, {
      method: "POST",
      headers: { "X-Session-ID": sessionId },
      body: form,
    });
    return res.ok;
  }

  static async sendCompanyData(records: CompanyDataRecord[]): Promise<boolean> {
    if (records.length === 0) return true; // nothing to forward
    const url = process.env.COMPANY_WEBHOOK_URL;
    if (!url) {
      console.warn("[WebhookService] COMPANY_WEBHOOK_URL not configured, skipping company webhook call");
      return true;
    }
    const csv = this.recordsToCSV(records as unknown as Record<string, unknown>[], [
      "uuid",
      "company_name",
      "person_name_th",
      "person_name_en",
      "status",
      "session_id",
    ]);
    const sessionId = records[0]?.session_id || "";
    return this.post(url, csv, sessionId, `company-${sessionId || "data"}.csv`);
  }

  static async sendFacebookData(records: FacebookDataRecord[]): Promise<boolean> {
    if (records.length === 0) return true;
    const url = process.env.FACEBOOK_WEBHOOK_URL;
    if (!url) {
      console.warn("[WebhookService] FACEBOOK_WEBHOOK_URL not configured, skipping facebook webhook call");
      return true;
    }
    const csv = this.recordsToCSV(records as unknown as Record<string, unknown>[], [
      "uuid",
      "fb_name",
      "timestamp",
      "upload_person_name",
      "session_id",
    ]);
    const sessionId = records[0]?.session_id || "";
    return this.post(url, csv, sessionId, `facebook-${sessionId || "data"}.csv`);
  }
}
