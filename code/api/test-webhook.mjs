/**
 * Webhook diagnostic script.
 *
 * Sends the SAME requests the API sends to the external promptxai webhooks,
 * then prints the full raw response (status, headers, body) plus DNS / timing
 * info. Use this to figure out why the API returns 502 Bad Gateway: a 502 from
 * the API means the external webhook responded with a non-OK status — this
 * script shows you exactly what that response was.
 *
 * Run:  node test-webhook.mjs              (tests all three webhooks)
 *       node test-webhook.mjs compare      (tests only the compare webhook)
 */

import 'dotenv/config';
import dns from 'node:dns/promises';

const TARGETS = {
  compare: {
    url: process.env.COMPARE_WEBHOOK_URL,
    contentType: 'application/json',
    sessionId: 'diag-test-session',
    body: JSON.stringify({
      session_id: 'diag-test-session',
      callback_url: `${(process.env.WEBHOOK_CALLBACK_URL_BASE || 'http://localhost:4000').replace(/\/+$/, '')}/api/callbacks/comparison-results`,
    }),
  },
  // The two upload webhooks take the CSV as an uploaded file (multipart, part named
  // `file`, text/csv). A raw text/csv request body is rejected 415 by the receiver — see
  // the note in src/services/webhook.service.ts.
  company: {
    url: process.env.COMPANY_WEBHOOK_URL,
    upload: { filename: 'company-diag-test-session.csv', contentType: 'text/csv' },
    sessionId: 'diag-test-session',
    body: [
      'uuid,company_name,person_name_th,person_name_en,status,session_id',
      'diag-1,Diag Co,ทดสอบ,Diag Person,pending,diag-test-session',
    ].join('\n'),
  },
  facebook: {
    url: process.env.FACEBOOK_WEBHOOK_URL,
    upload: { filename: 'facebook-diag-test-session.csv', contentType: 'text/csv' },
    sessionId: 'diag-test-session',
    body: [
      'uuid,fb_name,timestamp,upload_person_name,session_id',
      `diag-1,Diag FB,${new Date().toISOString()},Diag Person,diag-test-session`,
    ].join('\n'),
  },
};

const TIMEOUT_MS = 30_000;

function hr() {
  console.log('─'.repeat(70));
}

async function checkDns(url) {
  try {
    const { hostname } = new URL(url);
    const records = await dns.lookup(hostname, { all: true });
    console.log(`  DNS ${hostname} -> ${records.map((r) => r.address).join(', ')}`);
  } catch (err) {
    console.log(`  DNS lookup FAILED: ${err.message}`);
  }
}

async function testWebhook(name, target) {
  hr();
  console.log(`▶ ${name.toUpperCase()} webhook`);

  if (!target.url) {
    console.log(`  ✖ URL not configured (env var missing). Skipping.`);
    return;
  }

  console.log(`  URL: ${target.url}`);
  if (target.upload) {
    console.log(`  Mode: multipart/form-data — part "file", filename "${target.upload.filename}", ${target.upload.contentType}`);
  } else {
    console.log(`  Content-Type: ${target.contentType}`);
  }
  console.log(`  Body (${Buffer.byteLength(target.body)} bytes):`);
  console.log(
    target.body
      .split('\n')
      .map((l) => `    ${l}`)
      .join('\n')
  );

  await checkDns(target.url);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const start = Date.now();

  try {
    // Mirrors WebhookService.postCSV: fetch derives the multipart boundary itself, so the
    // Content-Type header is deliberately not set by hand for uploads.
    let requestHeaders;
    let requestBody;
    if (target.upload) {
      const form = new FormData();
      form.append('file', new Blob([target.body], { type: target.upload.contentType }), target.upload.filename);
      requestHeaders = { 'X-Session-ID': target.sessionId };
      requestBody = form;
    } else {
      requestHeaders = { 'Content-Type': target.contentType, 'X-Session-ID': target.sessionId };
      requestBody = target.body;
    }

    const response = await fetch(target.url, {
      method: 'POST',
      headers: requestHeaders,
      body: requestBody,
      signal: controller.signal,
    });

    const elapsed = Date.now() - start;
    const text = await response.text();

    console.log(`  ── Response in ${elapsed}ms ──`);
    console.log(`  Status: ${response.status} ${response.statusText}  (ok=${response.ok})`);
    console.log(`  Response headers:`);
    for (const [k, v] of response.headers.entries()) {
      console.log(`    ${k}: ${v}`);
    }
    console.log(`  Body (${Buffer.byteLength(text)} bytes):`);
    console.log(
      text
        .split('\n')
        .slice(0, 40)
        .map((l) => `    ${l}`)
        .join('\n') || '    (empty)'
    );

    if (response.ok) {
      console.log(`  ✔ Webhook accepted the request.`);
    } else if (response.status === 415) {
      const sent = target.upload ? 'multipart/form-data' : target.contentType;
      console.log(
        `  ⚠ 415 Unsupported Media Type — the webhook rejects "${sent}". The API sends the\n` +
          `    same thing, so response.ok is false and the upload endpoint returns 502 Bad\n` +
          `    Gateway. The receiver only parses content types it has a parser registered for.`
      );
    } else if (response.status === 404) {
      console.log(
        `  ⚠ 404 Not Found — this webhook ID is not active on promptxai (returns 404\n` +
          `    for every method/content-type). The workflow was deleted/unpublished or\n` +
          `    the URL/token is stale. A content-type fix alone will NOT help — you need\n` +
          `    a fresh webhook URL from promptxai for this workflow.`
      );
    } else if (response.status === 402) {
      // Seen for real on 2026-07-30: {"code":"QUOTA_EXCEEDED","params":{"metric":"tasks"}}
      console.log(
        `  ⚠ 402 Payment Required — the workflow PLATFORM refused the request before the\n` +
          `    flow ran; the body above names the exhausted limit (expect\n` +
          `    {"code":"QUOTA_EXCEEDED","params":{"metric":"tasks"}}). Nothing is wrong with\n` +
          `    the file, the content type or the URL — the project is out of task quota, so\n` +
          `    raise/reset it on the promptxai side. Tasks are consumed per step per row, so\n` +
          `    a flow that grew extra steps drains the quota far faster than it used to.\n` +
          `    A 402 the FLOW returned itself (respond-and-stop, e.g. relaying a paid API)\n` +
          `    looks different: it leaves a run in the flow's history and its body is the\n` +
          `    flow's own, not this envelope.`
      );
    } else if (response.status === 502) {
      console.log(
        `  ⚠ 502 Bad Gateway came directly from the webhook host — the upstream\n` +
          `    service behind their gateway is down/unreachable (promptxai side).`
      );
    } else {
      console.log(`  ⚠ Non-OK status. Your API would translate this into a 502 to the client.`);
    }
  } catch (err) {
    const elapsed = Date.now() - start;
    console.log(`  ✖ Request FAILED after ${elapsed}ms`);
    if (err.name === 'AbortError') {
      console.log(`    Timed out after ${TIMEOUT_MS}ms (no response from host).`);
    } else {
      console.log(`    ${err.name}: ${err.message}`);
      if (err.cause) console.log(`    cause: ${err.cause.code || err.cause.message || err.cause}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const arg = process.argv[2];
  const names = arg ? [arg] : Object.keys(TARGETS);

  console.log(`Webhook diagnostic — ${new Date().toISOString()}`);
  console.log(`Testing: ${names.join(', ')}`);

  for (const name of names) {
    const target = TARGETS[name];
    if (!target) {
      console.log(`Unknown target "${name}". Valid: ${Object.keys(TARGETS).join(', ')}`);
      continue;
    }
    await testWebhook(name, target);
  }
  hr();
}

main();
