import fs from 'fs';
import crypto from 'crypto';
import { parse } from 'csv-parse/sync';

export interface CompanyDataRecord {
  uuid: string;
  company_name: string | null;
  person_name_th: string | null;
  person_name_en: string | null;
  status: string | null;
  upload_person_name: string | null;
  session_id: string;
}

export interface FacebookDataRecord {
  uuid: string;
  fb_name: string | null;
  timestamp: string | null;
  upload_person_name: string | null;
  session_id: string;
}

interface FacebookFriend {
  name: string;
  timestamp: number;
}

interface FacebookExport {
  friends_v2?: FacebookFriend[];
}

export class FileParserService {
  /**
   * Parse CSV file containing company data.
   * Accepts either spaced ("Company Name", "Thai Name", "English Name") or
   * underscored ("company_name", "thai_name", "eng_name") headers — the real
   * export uses the latter.
   */
  static async parseCompanyCSV(
    filePath: string,
    sessionId: string,
    uploadPersonName?: string
  ): Promise<CompanyDataRecord[]> {
    // Async read so a large upload (up to the 500MB multer limit) doesn't block the event loop.
    const content = await fs.promises.readFile(filePath, 'utf-8');
    // Remove BOM if present
    const cleanContent = content.replace(/^﻿/, '');

    const records = parse(cleanContent, {
      columns: true,
      skip_empty_lines: true,
      trim: true
    }) as Record<string, string>[];

    // Normalize a header by dropping spaces/underscores and lowercasing, so
    // "Company Name", "company_name", "COMPANY_NAME", etc. all compare equal.
    const norm = (s: string): string => s.replace(/[\s_]+/g, '').toLowerCase();

    return records.map((record) => {
      const cell = (...headers: string[]): string | null => {
        for (const header of headers) {
          const target = norm(header);
          const match = Object.keys(record).find((k) => norm(k) === target);
          if (match && record[match]) return record[match];
        }
        return null;
      };

      return {
        uuid: crypto.randomUUID(),
        company_name: cell('company_name', 'Company Name', 'company'),
        person_name_th: cell('thai_name', 'Thai Name', 'thai'),
        person_name_en: cell('eng_name', 'English Name', 'English', 'eng'),
        status: null, // Not provided in source data
        upload_person_name: uploadPersonName || null,
        session_id: sessionId
      };
    });
  }

  /**
   * Parse JSON file containing Facebook data.
   * Expected format: { friends_v2: [{ name: string, timestamp: number }] }.
   * Timestamp is Unix epoch in seconds.
   */
  static async parseFacebookJSON(filePath: string, sessionId: string, uploadPersonName?: string): Promise<FacebookDataRecord[]> {
    const content = await fs.promises.readFile(filePath, 'utf-8');
    const data: FacebookExport = JSON.parse(content);

    // Facebook export has friends_v2 array
    const friends = data.friends_v2;

    if (!Array.isArray(friends)) {
      throw new Error('Facebook JSON must contain friends_v2 array');
    }

    return friends.map((record: FacebookFriend) => ({
      uuid: crypto.randomUUID(),
      fb_name: record.name || null,
      timestamp: record.timestamp ? new Date(record.timestamp * 1000).toISOString() : null,
      upload_person_name: uploadPersonName || null,
      session_id: sessionId
    }));
  }
}
