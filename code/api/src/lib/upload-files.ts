import fs from "fs";
import path from "path";
import crypto from "crypto";
import { pipeline } from "stream/promises";
import type { FastifyRequest } from "fastify";
import { env } from "../config/env";
import { BadRequest } from "./errors";
import { isSupportedUpload, UPLOAD_FORMATS } from "./table-file";

/**
 * Streaming multipart intake for the two files this app accepts: company data and a Facebook
 * friends list. Either may be a workbook, a CSV or a JSON export — the extension is the only thing
 * checked here, and it is checked against the reader registry (table-file.ts) rather than a list of
 * its own, so what the intake accepts is exactly what something downstream can read. Whether the
 * bytes really are what the name claims is the reader's question, not this one's.
 *
 * Shared by the import (`POST /api/comparisons/run`) and the preview
 * (`POST /api/upload-sessions/preview`) precisely so the two can't drift. A preview that
 * accepted a file the import would reject — or read it differently — would be worse than
 * no preview at all, because it would be a confident lie.
 */

const UPLOAD_DIR = env.UPLOAD_DIR || "uploads";
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/** Best-effort cleanup. A leftover temp file is not worth failing a request over. */
export const unlinkQuiet = (...paths: (string | null)[]): void => {
  for (const p of paths) {
    if (p && fs.existsSync(p)) {
      try {
        fs.unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
  }
};

export interface ParsedUpload {
  companyPath: string | null;
  facebookPath: string | null;
  /** Original filenames, for the preview to echo back. */
  companyFileName: string | null;
  facebookFileName: string | null;
  fields: Record<string, string>;
}

/** Stream companyFile + facebookFile (.xlsx, .csv or .json) to disk; collect text fields. */
export async function parseUpload(req: FastifyRequest): Promise<ParsedUpload> {
  const fields: Record<string, string> = {};
  let companyPath: string | null = null;
  let facebookPath: string | null = null;
  let companyFileName: string | null = null;
  let facebookFileName: string | null = null;
  const written: string[] = [];
  let error: Error | null = null;

  for await (const part of req.parts()) {
    if (part.type === "file") {
      const readable = isSupportedUpload(part.filename || "");
      try {
        if (part.fieldname === "companyFile" && readable) {
          companyPath = path.join(UPLOAD_DIR, `${crypto.randomUUID()}-${part.filename}`);
          companyFileName = part.filename;
          await pipeline(part.file, fs.createWriteStream(companyPath));
          written.push(companyPath);
          if (part.file.truncated && !error) error = new BadRequest("Company file exceeds the size limit");
        } else if (part.fieldname === "facebookFile" && readable) {
          facebookPath = path.join(UPLOAD_DIR, `${crypto.randomUUID()}-${part.filename}`);
          facebookFileName = part.filename;
          await pipeline(part.file, fs.createWriteStream(facebookPath));
          written.push(facebookPath);
          if (part.file.truncated && !error) error = new BadRequest("Facebook file exceeds the size limit");
        } else {
          await part.toBuffer().catch(() => undefined); // drain rejected/unknown file
          if (!error && part.fieldname === "companyFile")
            error = new BadRequest(`Company file must be ${UPLOAD_FORMATS}`);
          if (!error && part.fieldname === "facebookFile")
            error = new BadRequest(`Facebook file must be ${UPLOAD_FORMATS}`);
        }
      } catch (e) {
        if (!error) error = e as Error;
      }
    } else {
      fields[part.fieldname] = part.value as string;
    }
  }

  if (error) {
    unlinkQuiet(...written);
    throw error;
  }
  return { companyPath, facebookPath, companyFileName, facebookFileName, fields };
}
