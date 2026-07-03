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
   * Expected columns: "Company Name", "Thai Name".
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

    return records.map((record) => ({
      uuid: crypto.randomUUID(),
      company_name: record['Company Name'] || null,
      person_name_th: record['Thai Name'] || null,
      person_name_en: null, // Not provided in source data
      status: null, // Not provided in source data
      upload_person_name: uploadPersonName || null,
      session_id: sessionId
    }));
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
