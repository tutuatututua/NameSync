import fetch from 'node-fetch';
import { CompanyDataRecord, FacebookDataRecord } from './file-parser.service';

const WEBHOOK_URLS = {
  company: process.env.COMPANY_WEBHOOK_URL,
  facebook: process.env.FACEBOOK_WEBHOOK_URL
};

export class WebhookService {
  /**
   * Convert records to CSV format
   */
  static recordsToCSV(records: Record<string, any>[], columns: string[]): string {
    if (records.length === 0) return '';
    
    const header = columns.join(',');
    const rows = records.map(record => 
      columns.map(col => {
        const value = record[col];
        if (value === null || value === undefined) return '';
        const str = String(value);
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
          return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
      }).join(',')
    );
    
    return [header, ...rows].join('\n');
  }

  /**
   * Send company data to webhook
   */
  static async sendCompanyData(records: CompanyDataRecord[]): Promise<boolean> {
    if (records.length === 0) {
      // Nothing to forward (e.g. a Facebook-only upload with a placeholder company file).
      return true;
    }

    if (!WEBHOOK_URLS.company) {
      console.warn('[WebhookService] COMPANY_WEBHOOK_URL not configured, skipping company webhook call');
      return true;
    }

    const csv = this.recordsToCSV(records, ['uuid', 'company_name', 'person_name_th', 'person_name_en', 'status', 'session_id']);
    
    const response = await fetch(WEBHOOK_URLS.company, {
      method: 'POST',
      headers: {
        // Body is CSV text. The receiver (Fastify) has no text/csv parser and
        // returns 415 for it, so declare text/plain — the raw bytes are identical.
        'Content-Type': 'text/plain',
        'X-Session-ID': records[0]?.session_id || ''
      },
      body: csv
    });

    return response.ok;
  }

  /**
   * Send Facebook data to webhook
   */
  static async sendFacebookData(records: FacebookDataRecord[]): Promise<boolean> {
    if (records.length === 0) {
      // Nothing to forward (e.g. a Company-only upload, or no unprocessed rows).
      return true;
    }

    if (!WEBHOOK_URLS.facebook) {
      console.warn('[WebhookService] FACEBOOK_WEBHOOK_URL not configured, skipping facebook webhook call');
      return true;
    }

    const csv = this.recordsToCSV(records, ['uuid', 'fb_name', 'timestamp', 'upload_person_name', 'session_id']);
    
    const response = await fetch(WEBHOOK_URLS.facebook, {
      method: 'POST',
      headers: {
        // Body is CSV text. The receiver (Fastify) has no text/csv parser and
        // returns 415 for it, so declare text/plain — the raw bytes are identical.
        'Content-Type': 'text/plain',
        'X-Session-ID': records[0]?.session_id || ''
      },
      body: csv
    });

    return response.ok;
  }
}
