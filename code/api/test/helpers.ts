import FormData from "form-data";
import { sql } from "kysely";
import { DBModel } from "@extensions/sqldb";
import type { FastifyInstance } from "fastify";

export async function truncateAll(): Promise<void> {
  const pool = await DBModel.getPool();
  const db = await pool.connect();
  await sql`TRUNCATE company_data, facebook_data, comparison_results, upload_sessions, history_sessions, upload_history RESTART IDENTITY CASCADE`.execute(
    db
  );
}

const DEFAULT_CSV = "Company Name,Thai Name,English Name\nAcme Co,สมชาย,Somchai\nBeta Ltd,อนงค์,Anong\n";
const DEFAULT_JSON = JSON.stringify({
  friends_v2: [
    { name: "Somchai", timestamp: 1700000000 },
    { name: "Anong", timestamp: 1700000100 },
  ],
});

/** POST /api/comparisons with a company CSV + facebook JSON via multipart. */
export function uploadComparison(
  app: FastifyInstance,
  opts: { name?: string; csv?: string; json?: string; uploadPersonName?: string } = {}
) {
  const form = new FormData();
  form.append("name", opts.name ?? "Test Comparison");
  form.append("mode", "fresh");
  form.append("uploadPersonName", opts.uploadPersonName ?? "Tester");
  form.append("companyFile", Buffer.from(opts.csv ?? DEFAULT_CSV), {
    filename: "company.csv",
    contentType: "text/csv",
  });
  form.append("facebookFile", Buffer.from(opts.json ?? DEFAULT_JSON), {
    filename: "friends.json",
    contentType: "application/json",
  });
  return app.inject({
    method: "POST",
    url: "/api/comparisons",
    payload: form,
    headers: form.getHeaders(),
  });
}

interface ResultItem {
  fb_name: string;
  person_name_en: string;
  person_name_th: string;
  matching_score: number;
}

export function postCallback(
  app: FastifyInstance,
  body: {
    session_id: string;
    batch_number: number;
    total_batches: number;
    is_complete: boolean;
    results: ResultItem[];
  }
) {
  return app.inject({ method: "POST", url: "/api/callbacks/comparison-results", payload: body });
}
