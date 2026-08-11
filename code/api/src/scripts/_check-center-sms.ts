import "dotenv/config";
import { env } from "../config/env";
import { centerLogin, centerMe, type CenterProfile } from "../lib/center";

/**
 * Temp diagnostic: why doesn't the SMS enrolment code arrive?
 *
 * The symptom this exists for is a silent one. `POST /api/auth/2fa/sms/send-code` answers 200
 * whenever Center hands back a `refID`, and Center hands one back for a request it accepted —
 * which is not the same as a message it sent. So the app can only ever report "we texted you",
 * and every failure downstream of that looks identical from the outside.
 *
 * This calls Center's sendcode directly and prints the RAW status and body, which is the one
 * piece of evidence the app throws away. It runs against LIVE Center and sends REAL texts, so
 * it asks for a real number and does one variant unless told otherwise.
 *
 * ── Run it ────────────────────────────────────────────────────────────────────
 *   cd code/api
 *   CENTER_TEST_EMAIL=you@example.com \
 *   CENTER_TEST_PASSWORD='…' \
 *   CENTER_TEST_CODE=123456 \            # only if your account has 2FA on already
 *   SMS_TEST_NUMBER=812345678 \          # NO leading 0 — see toInternational in the settings card
 *   npx tsx src/scripts/_check-center-sms.ts
 *
 * Add SMS_TEST_VARIANTS=all to try the payload spellings this app is unsure about. Each variant
 * is one more real text, so they are opt-in.
 *
 * Delete this file once SMS is confirmed working — it is a probe, not a feature.
 */

const REDACT = (s: string): string => (s.length <= 4 ? "…" : `${s.slice(0, 2)}…${s.slice(-2)}`);

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`✗ ${name} is required. See the header of this file for the full command.`);
    process.exit(1);
  }
  return value;
}

/** Center's base URL with a guaranteed trailing slash — lib/center.ts keeps this private. */
function base(): string {
  const url = env.CENTER_PLAYME_URL;
  if (!url) {
    console.error("✗ CENTER_PLAYME_URL is not set — this process cannot reach Center at all.");
    process.exit(1);
  }
  return url.endsWith("/") ? url : `${url}/`;
}

/**
 * The payload spellings worth testing, and why each is in doubt.
 *
 * `app` is what the running code sends. The other two exist because these field names were
 * replicated from a working Center client rather than a published spec (see the note above
 * centerSendSmsEnrollCode), and two of the guesses are load-bearing:
 *
 *   isEmail       — every other caller treats it as "deliver by email", so enrolment sends
 *                   false. Center's own 2FA settings page reportedly sends TRUE here even while
 *                   passing a phone number, which would mean the flag means something else.
 *   username/email — sendcode wants the account ID in `username` and the handle in `email`,
 *                   which is the reverse of every other Center call. If CenterProfile.id fell
 *                   back to the username (Center omits `id` on some tenants) both fields carry
 *                   the same value and this is untestable from the app — hence the swap.
 */
type Variant = { key: string; why: string; body: (p: PhonePayload) => Record<string, unknown> };

interface PhonePayload {
  handle: string;
  id: string;
  phoneCountry: string;
  phoneNumber: string;
  group: { groupIam2ID?: string };
}

const VARIANTS: Variant[] = [
  {
    key: "isEmail-true",
    why: "what the app sends since 2026-08-10, and what Center's own 2FA page sends",
    body: (p) => ({
      email: p.handle,
      phoneNumber: p.phoneNumber,
      phoneCountry: p.phoneCountry,
      isVerifyAccount: true,
      username: p.id,
      isEmail: true,
      ...p.group,
    }),
  },
  {
    key: "isEmail-false",
    why: "the previous value — traced as 201 + refID + empty status, and no text",
    body: (p) => ({
      email: p.handle,
      phoneNumber: p.phoneNumber,
      phoneCountry: p.phoneCountry,
      isVerifyAccount: true,
      username: p.id,
      isEmail: false,
      ...p.group,
    }),
  },
];

/*
 * A third variant lived here — handle and id swapped — on the theory that sendcode might read
 * those fields like every other Center call. A traced enrolment settled it: Center returned
 * `username=b7aa0ee3-…`, a real account UUID rather than the handle this app falls back to, so
 * the mapping was right all along. Removed rather than left switched off, because every variant
 * here costs a real text message to a real phone.
 */

async function attempt(variant: Variant, token: string, payload: PhonePayload): Promise<void> {
  const body = variant.body(payload);
  console.log(`\n── ${variant.key} — ${variant.why}`);
  console.log("   request :", JSON.stringify(body));
  try {
    const res = await fetch(`${base()}auth/sendcode`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    console.log(`   status  : ${res.status}`);
    console.log(`   response: ${text || "(empty body)"}`);
    // A refID is what the app treats as success — printed separately because it is precisely
    // the signal that has been lying: it means "accepted", never "delivered".
    try {
      const data = JSON.parse(text) as Record<string, unknown>;
      if (typeof data.refID === "string" && data.refID) {
        console.log(`   → refID ${data.refID} (the app would call this a success and move on)`);
      } else {
        console.log("   → no refID: the app would REFUSE this one and show Center's message.");
      }
    } catch {
      console.log("   → response was not JSON.");
    }
  } catch (err) {
    console.log("   ✗ the call itself failed:", err instanceof Error ? err.message : err);
  }
}

async function main(): Promise<void> {
  const email = required("CENTER_TEST_EMAIL");
  const password = required("CENTER_TEST_PASSWORD");
  const phoneNumber = required("SMS_TEST_NUMBER");
  const phoneCountry = process.env.SMS_TEST_COUNTRY ?? "66";
  const code = process.env.CENTER_TEST_CODE;

  console.log("Center   :", base());
  console.log(
    "Group id :",
    env.CENTER_GROUP_IAM2_ID
      ? JSON.stringify(env.CENTER_GROUP_IAM2_ID)
      : "(unset — the key is now omitted entirely rather than sent as \"\")"
  );
  console.log("Texting  :", `+${phoneCountry}${phoneNumber}`);
  if (/^0/.test(phoneNumber)) {
    console.log(
      "   ⚠ that number starts with 0. With a country code in front, the national trunk 0 is\n" +
        "     not part of the number — +66 081… is not a valid line, and Center will still\n" +
        "     answer with a refID. Try it without the 0."
    );
  }

  // Step one: a real Center token, exactly as the re-auth window gets one.
  console.log(`\nSigning in to Center as ${email} …`);
  const login = await centerLogin({
    username: email,
    password,
    ...(code ? (process.env.CENTER_TEST_METHOD === "email" || process.env.CENTER_TEST_METHOD === "sms"
      ? { otp: code, otpRef: process.env.CENTER_TEST_REF }
      : { totp: code }) : {}),
  });

  if (login.kind === "twoFactor") {
    console.log(`✗ Center wants a second factor first (method: ${login.method}, ref: ${login.ref ?? "none"}).`);
    console.log("  Re-run with CENTER_TEST_CODE=<the code>, plus CENTER_TEST_METHOD/CENTER_TEST_REF for an emailed or texted one.");
    return;
  }
  console.log(`✓ token acquired (${REDACT(login.token)})`);

  // Step two: who Center thinks we are. `username` and `id` are what sendcode keys on, and if
  // `id` merely echoes `username` then Center never returned one — worth seeing before blaming
  // the payload.
  const profile: CenterProfile = await centerMe(login.token);
  console.log("Profile  :", { username: profile.username, id: profile.id, email: profile.email });
  if (profile.id && profile.id === profile.username) {
    console.log("   ⚠ id == username: Center returned no separate account id, so this app fell back\n" +
      "     to the handle. sendcode expects the ID in `username`, so it is receiving a handle.");
  }

  const payload: PhonePayload = {
    handle: profile.username ?? email,
    id: profile.id ?? profile.username ?? email,
    phoneCountry,
    phoneNumber,
    group: env.CENTER_GROUP_IAM2_ID ? { groupIam2ID: env.CENTER_GROUP_IAM2_ID } : {},
  };

  const all = process.env.SMS_TEST_VARIANTS === "all";
  const chosen = all ? VARIANTS : VARIANTS.slice(0, 1);
  console.log(
    `\nSending ${chosen.length} request(s) — each one is a REAL text if Center dispatches it.` +
      (all ? "" : " Set SMS_TEST_VARIANTS=all to try the other spellings.")
  );

  for (const variant of chosen) await attempt(variant, login.token, payload);

  console.log(
    "\nNow check the handset. Whichever variant arrives is the payload centerSendSmsEnrollCode\n" +
      "should use (api/src/lib/center.ts). If NONE arrives but every response looks healthy, the\n" +
      "gap is inside Center — its SMS gateway for this account or group — and not something this\n" +
      "app can fix from here; that is the point to take these responses to whoever runs Center."
  );
}

main().catch((err) => {
  console.error("check failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
