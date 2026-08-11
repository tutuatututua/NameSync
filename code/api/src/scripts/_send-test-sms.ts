/**
 * Temp diagnostic: ask Center to text a phone, with no account and no password involved.
 *
 * ── Why this can work without credentials ─────────────────────────────────────
 * Center's `auth/sendcode` is reachable unauthenticated — that is how its own account-creation
 * flow texts a confirmation code to a phone that does not belong to an account yet. The app's
 * enrolment call (centerSendSmsEnrollCode) is the same endpoint with a bearer token attached.
 *
 * ── What it is for ────────────────────────────────────────────────────────────
 * The enrolment path answers 200 with a refID and then no text arrives, and a refID means
 * "accepted", never "delivered" — so the app cannot tell a working gateway from a silent one.
 * This bisects that:
 *
 *   a text arrives  → Center's SMS gateway works for this tenant, and the fault is in the
 *                     authenticated enrolment payload (the isEmail flag, or the username/email
 *                     mapping). Those variants are then worth testing.
 *   nothing arrives → the gateway is not dispatching for this setup at all. No change to this
 *                     codebase can fix that, and the responses printed below are the evidence
 *                     to take to whoever runs Center.
 *
 * Either way it prints Center's RAW status and body, which is the piece lib/center.ts discards.
 *
 * ── Run it ────────────────────────────────────────────────────────────────────
 *   cd code/api
 *   SMS_TEST_NUMBER=945715588 npx tsx src/scripts/_send-test-sms.ts
 *
 * SMS_TEST_NUMBER is the national number WITHOUT the trunk 0 (+66 0945… is not a line).
 * Optional: SMS_TEST_COUNTRY (default 66), SMS_TEST_HANDLE (the account handle to quote),
 * CENTER_PLAYME_URL / CENTER_GROUP_IAM2_ID (default to the deployed values).
 *
 * THIS SENDS REAL TEXT MESSAGES — one per variant. Delete this file once SMS is settled.
 */

const CENTER = (process.env.CENTER_PLAYME_URL ?? "https://centerapp.io/center/").replace(/\/?$/, "/");
const GROUP = process.env.CENTER_GROUP_IAM2_ID ?? "";
const COUNTRY = process.env.SMS_TEST_COUNTRY ?? "66";
const HANDLE = process.env.SMS_TEST_HANDLE ?? "anu.elias@gmail.com";
const RAW_NUMBER = process.env.SMS_TEST_NUMBER ?? "";

/** Center rejects an unexpected group id, so an unset one is omitted rather than sent empty. */
const group = GROUP ? { groupIam2ID: GROUP } : {};

interface Variant {
  key: string;
  why: string;
  body: Record<string, unknown>;
}

function variants(phoneNumber: string): Variant[] {
  const common = {
    email: HANDLE,
    phoneNumber,
    phoneCountry: COUNTRY,
    isVerifyAccount: true,
    username: HANDLE,
    ...group,
  };
  return [
    { key: "A", why: "isEmail:false — exactly what the app sends today", body: { ...common, isEmail: false } },
    { key: "B", why: "isEmail:true — what Center's own 2FA settings page reportedly sends", body: { ...common, isEmail: true } },
  ];
}

async function send(v: Variant): Promise<void> {
  console.log(`\n── ${v.key}: ${v.why}`);
  console.log("   request :", JSON.stringify(v.body));
  try {
    const res = await fetch(`${CENTER}auth/sendcode`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(v.body),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    console.log("   status  :", res.status);
    console.log("   response:", text || "(empty body)");
    try {
      const data = JSON.parse(text) as Record<string, unknown>;
      const ref = typeof data.refID === "string" ? data.refID : "";
      console.log(
        ref
          ? `   → refID ${ref} — this is what the app calls success. It is NOT proof of delivery.`
          : "   → no refID — the app would refuse this one and show Center's own message."
      );
    } catch {
      console.log("   → response was not JSON.");
    }
  } catch (err) {
    console.log("   ✗ the call itself failed:", err instanceof Error ? err.message : err);
  }
}

async function main(): Promise<void> {
  if (!RAW_NUMBER) {
    console.error("✗ SMS_TEST_NUMBER is required, e.g. SMS_TEST_NUMBER=945715588");
    process.exit(1);
  }
  // The trunk 0 is not part of the number once a country code precedes it, and Center answers a
  // bad number with a refID like any other — so it is stripped here rather than silently sent.
  const phoneNumber = RAW_NUMBER.replace(/\D/g, "").replace(/^0+/, "");

  console.log("Center  :", CENTER);
  console.log("Group id:", GROUP ? JSON.stringify(GROUP) : "(unset — the key is omitted)");
  console.log("Handle  :", HANDLE);
  console.log("Texting :", `+${COUNTRY}${phoneNumber}`);
  if (phoneNumber !== RAW_NUMBER.replace(/\D/g, "")) {
    console.log(`   (dropped the leading 0 from ${RAW_NUMBER})`);
  }
  console.log("\nSending 2 requests — each is a REAL text if Center dispatches it.");

  for (const v of variants(phoneNumber)) await send(v);

  console.log(
    "\nNow check the handset:\n" +
      "  • a text arrived → the gateway works; the fault is the enrolment payload. Note WHICH\n" +
      "    variant arrived and change centerSendSmsEnrollCode in api/src/lib/center.ts to match.\n" +
      "  • nothing arrived → Center is accepting and not dispatching. That is Center's side, not\n" +
      "    this app's; take the responses above to whoever administers it."
  );
}

main().catch((err) => {
  console.error("failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
