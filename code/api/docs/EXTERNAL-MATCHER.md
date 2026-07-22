# The external matcher workflow

How Network Intel hands an import to the workflow, and what the workflow must do with it.

This is a **contract between two systems that share one database**. Network Intel does not receive
the results over HTTP — it reads them out of Postgres, by polling. So every promise below is
about a table, not an endpoint.

---

## Turning it on

Nothing in this document takes effect until **`EXTERNAL_MATCHER=1`** is set on the API.

With the flag off (the default), Network Intel behaves exactly as it always has: pressing
**Compare** scores the names itself, in Postgres, and returns the run immediately. That path
is untouched and still works — the flag chooses which matcher runs, and both remain.

The `status` columns the workflow writes to are part of [`schema-redesign.sql`](schema-redesign.sql),
so a database built from it is ready as-is. A database created from an *older* schema needs the
drift migrations in [`migrations/`](migrations/) applied by hand — the app never issues DDL
(`DB_SKIP_MIGRATE=1`), by design.

> ### ⚠️ Breaking change — `comparison_result.is_complete` is gone
>
> [`migrations/2026-07-17-single-clean-name-and-result-status.sql`](migrations/2026-07-17-single-clean-name-and-result-status.sql)
> **drops the `is_complete` column** from `comparison_result` and adds `status` in its place.
> Any workflow whose `INSERT` names `is_complete` starts failing with
> `ERROR: column "is_complete" of relation "comparison_result" does not exist` **the moment that
> migration lands** — not gradually, and not with a warning. There is no compatibility window,
> because a dropped column has no reads left to serve.
>
> **So the migration and the workflow must be coordinated: change the workflow's `INSERT` first**
> (to the template in [§2b](#b-the-result-if-it-matched)), or take the workflow's writes down for
> the duration and apply both together.
>
> The same migration collapses the `_clean` name columns into one column per name — see
> [§1](#1-what-networkintel-sends). A workflow reading `person_name_th_clean`, `fb_name_clean` or the
> `timestamp` column out of the CSV stops finding them at the same moment.
>
> This does **not** affect the `is_complete` field on the HTTP callback body, which is a different
> thing that survives untouched — see [§4](#4-the-http-callback-path).

**`COMPANY_WEBHOOK_URL` and `FACEBOOK_WEBHOOK_URL` are required with the flag on.** The
webhook is the pipeline in this mode, so an import is refused up front (503, nothing stored)
if its URL is missing. With the flag off the URLs are optional — an unconfigured one just
means the import isn't forwarded anywhere.

---

## The flow

```
user imports a file
        │
        ▼
Network Intel  ─── writes rows to friend / company_contact, each status='processing'
          ─── creates one `comparison` row (status='processing')  ← this is the run
          ─── POSTs the rows to the webhook, carrying the comparison id
        │
        ▼
workflow  ─── matches each row against the opposite table
          ─── writes comparison_result rows  (the pair + the score)
          ─── stamps each source row  status = 'match' | 'unmatch'
        │
        ▼
Network Intel  ─── polls: "does this upload still have unfinished rows?"
                     ('pending' or 'processing' — both mean no verdict yet)
          ─── when none do: upload → 'completed', comparison → 'completed'
          ─── the user, who has been watching the Compare page, sees the results
```

A **Facebook** import is matched against every contact in `company_contact`.
A **company** import is matched against every friend in `friend`.
(Which is why an import can start a run on its own — the other side is already on file.)

---

## 1. What Network Intel sends

`POST` to `FACEBOOK_WEBHOOK_URL` (social imports) or `COMPANY_WEBHOOK_URL` (company imports),
as `multipart/form-data` with a single `file` part — a CSV, exactly as today.

**Headers**

| Header | Meaning |
|---|---|
| `X-Upload-ID` | The **upload** id. Which import this is. |
| `X-Session-ID` | Same value as `X-Upload-ID` — the legacy spelling, kept for workflows already reading it. |
| `X-Comparison-ID` | The **run** id. **Write `comparison_result.comparison_id` with this.** |
| `X-Row-Count` | How many data rows the CSV holds (excluding the header). |

`X-Comparison-ID` is the important one: it is the only way the results you write can be
attached to the run the user is watching. `X-Row-Count` lets you size the job — and tell a
truncated download from a small import — without parsing the file first.

**CSV columns — company import**

```
uuid,company_name,person_name_th,person_name_en,upload_person_name,status,session_id,comparison_id
```

**CSV columns — social import**

```
uuid,fb_name,upload_person_name,status,session_id,comparison_id
```

`uuid` is the row's primary key — `company_contact.id` or `friend.id`. It is what you write
back against. `status` will read `processing` on every row, because that is what it is.

**There is one column per name, and it is already cleaned.** Titles, suffixes and nicknames are
stripped and the result is **lower-cased**, at import, before the row is stored — so
`Mr. Somchai Jaidee` arrives as `somchai jaidee` and `นายสมชาย ใจดี` as `สมชาย ใจดี`. **Match on the
column you are handed**: it is the only spelling Network Intel stores, and it is exactly what the
internal matcher matches on. Middle names are **kept** (`Somchai J. Jaidee` → `somchai j. jaidee`).

There are no `_clean` columns any more, and no `timestamp` column — both were dropped on
2026-07-17. The `_clean` twins existed to sit beside a raw column that no longer exists; a
workflow matching on the name it is given is now matching on the right thing by construction,
rather than by remembering which of two columns was the good one.

A name cell is **empty** when nothing survived cleaning (a "name" that was only a title, e.g.
`Mr.`). There is no raw column to fall back to — an empty cell means there was no name here.

`company_name` is the exception: it is **tidied only** (whitespace and invisible characters),
**not** cleaned and **not** lower-cased. Its capitalisation is the file's own. Match it
case-insensitively.

The `comparison_id` column carries the same value as the `X-Comparison-ID` header. It is
duplicated into every row on purpose: a row-wise tool (n8n and friends) can reach a CSV cell
far more easily than a request header.

### The request, in full

This is the whole of what arrives — a company import of two contacts who share an employer with
a comma in its name, so the quoting rules are visible rather than described. The second contact
was recorded in the file as `สุดา "Su" ใจดี` / `Suda "Su" Jaidee`; note what reaches you:

```http
POST /company HTTP/1.1
host: wf.promptxai.com
x-upload-id: 22
x-session-id: 22
x-comparison-id: 12
x-row-count: 2
content-type: multipart/form-data; boundary=----formdata-undici-056721390935

------formdata-undici-056721390935
Content-Disposition: form-data; name="file"; filename="company-22.csv"
Content-Type: text/csv

uuid,company_name,person_name_th,person_name_en,upload_person_name,status,session_id,comparison_id
325,"Wire Demo, Inc.",ปรีชา วงศ์,preecha wong,Nadhee,processing,22,12
326,"Wire Demo, Inc.",สุดา ใจดี,suda jaidee,Nadhee,processing,22,12
------formdata-undici-056721390935--
```

And a social import of two friends:

```http
POST /facebook HTTP/1.1
host: wf.promptxai.com
x-upload-id: 23
x-session-id: 23
x-comparison-id: 13
x-row-count: 2
content-type: multipart/form-data; boundary=----formdata-undici-012377751986

------formdata-undici-012377751986
Content-Disposition: form-data; name="file"; filename="facebook-23.csv"
Content-Type: text/csv

uuid,fb_name,upload_person_name,status,session_id,comparison_id
1320,preecha wong,Nadhee,processing,23,13
1321,suda jaidee,Nadhee,processing,23,13
------formdata-undici-012377751986--
```

Things worth reading twice:

- **It is a file part, not a request body.** One part, named `file`, `text/csv`, with a `.csv`
  filename. Read it the way you would read an uploaded attachment. A raw `text/csv` body is what
  this *used* to send, and Fastify answered every one of them with `415`.
- **The boundary is generated per request.** Never hard-code it — parse the `content-type`.
- **Quoting is RFC 4180.** A field is quoted only if it holds a comma, a double-quote or a
  newline; an embedded double-quote is doubled (`""`). `"Wire Demo, Inc."` above is real output,
  not an illustration. A naive `split(",")` tears that row in half — use a CSV parser.
- **Quoting bites on `company_name` and `upload_person_name`, not on the names.** Cleaning
  removes commas and quotes from a person's name, so `person_name_*` and `fb_name` arrive bare;
  `company_name` is tidied only, so it keeps whatever punctuation the file had. Parse properly
  anyway — which fields need quoting is not a promise, it's an artifact of this month's data.
- **The names are lower-cased; `company_name` is not.** `preecha wong` and `suda jaidee` above
  are the stored spelling, not a display one. Compare company names case-insensitively.
- **Nicknames are already gone.** Row 326 was `สุดา "Su" ใจดี` in the source file. You get
  `สุดา ใจดี`. There is nowhere to read the original — this is the point, not a loss.
- **UTF-8, unquoted Thai.** Thai text carries no comma or quote, so it arrives bare. It is still
  UTF-8; decode accordingly.
- **`status` is `processing` on every row**, always. It is the column you are being asked to
  change, not one that tells you anything.
- **The rows are the *new* ones only.** Duplicates were dropped at import, so a 500-row file that
  is 480 rows you already have arrives as 20 rows. An import that adds nothing sends no request at
  all — there is nothing to match, and no run is opened for it.

---

## 2. What the workflow must write

For **every row it is given** — including the ones that match nobody.

### a. The verdict, on the source row

```sql
UPDATE lakeshore.friend           -- or lakeshore.company_contact
   SET status = 'match',          -- or 'unmatch'
       updated_at = now()
 WHERE id = :uuid;
```

| Value | Means | Reads as |
|---|---|---|
| `pending` | Accepted, not picked up yet. | **unfinished** |
| `processing` | Being worked on. The column's default — what every row starts at. | **unfinished** |
| `match` | Decided: this row was matched to someone. | finished |
| `unmatch` | Decided: this row matched nobody. | finished |
| `fail` / `failed` / `error` / `errored` | You gave up on this row. | failed |

**A row must never be left unfinished.** That is the single hard requirement here. `pending` and
`processing` *both* mean "no verdict yet", and Network Intel decides an import is finished by asking
whether any of its rows are still at either — so one row left behind means the import never
completes, the Compare page spins forever, and the user is told a job is running that is not.

The two unfinished spellings exist so you can distinguish a row you have accepted from a row you
are working on. Nothing downstream branches on which one it is; both keep the import open.

There is no CHECK constraint on the column: an unexpected value will be stored, and Network Intel
will read it as **finished** rather than rejecting your write. Only the spellings above carry
meaning — `pending` / `processing` hold the import open, the four failure spellings mark the row
failed, and anything else, including a value you invent, falls through to the score. Values are
trimmed and lower-cased when read, so `Match` and `unmatch ` are understood.

**`match` and `unmatch` are the verdict**, as of 2026-07-20 — they used to be advisory. See
[§2c](#c-your-verdict-is-the-verdict).

### b. The result, if it matched

```sql
INSERT INTO lakeshore.comparison_result
  (comparison_id, friend_name, person_name_en, person_name_th,
   batch_number, status, upload_name, company_name, extra)
VALUES
  (:comparison_id,      -- from X-Comparison-ID / the CSV column
   :friend_name,        -- the Facebook side of the pair
   :person_name_en,     -- the company side
   :person_name_th,
   1,
   'match',             -- or 'unmatch'. THE VERDICT. See the vocabulary below.
   :uploaded_by,        -- who imported the friend, when known
   :company_name,       -- where the matched contact works, if you know it; NULL is fine
   NULL);
```

> **`matching_score` is not in this list, and naming it will now fail the write.** The column was
> dropped on 2026-07-20 and `status` absorbed its job. If you still want to send the number, put it
> in `extra` — it will be kept and shown as an extra column in the results table. It will not
> decide anything.

> **`is_complete` is not in this list, and naming it will now fail the write.** The column was
> dropped on 2026-07-17 and `status` took its place. They are not the same fact and there is no
> mechanical translation between them: `is_complete` was a *batch transport* flag ("this row came
> in the last batch"), denormalised onto every row, so two identically-decided rows carried
> `false` in batch 1 and `true` in batch 9. `status` is about the row. If your `INSERT` names
> `is_complete`, change it before the migration runs — see the warning at the top of this file.
>
> The `is_complete` field on the **HTTP callback body** is untouched and still means what it
> always meant. Same word, different layer. See [§4](#4-the-http-callback-path).

Two column names worth checking against your `INSERT`, since neither matches the CSV you were
handed: the Facebook side of the pair is **`friend_name`** here (the CSV calls it `fb_name`), and
`extra` (`jsonb`) is there for any non-standard fields you want to keep — it is unchanged, and
NULL is a perfectly good value for it.

#### The `status` vocabulary

Same words as the source row — and, since 2026-07-20, the whole of the answer:

| Value | Means | Reads as |
|---|---|---|
| `pending` | Accepted, no verdict yet. **The column default** — a placeholder row inserted ahead of its verdict reads as unfinished, not as a silent "no match". | **unfinished** |
| `processing` | Working on it. | **unfinished** |
| `match` (or `matched`) | Decided, and it matched. | **matched** |
| `unmatch` | Decided, no match. | unmatched |
| `fail` / `failed` / `error` / `errored` | You gave up on this row. | failed |
| *anything else* | Decided, and not one of the matched spellings. | unmatched |

Two things follow from that last row, and they are the ones to get right:

- **A typo is a silent non-match.** `Match` and `match ` are fine (values are trimmed and
  lower-cased), but `MATCHED_OK` or `hit` reads as *unmatched* — no error, no warning, just a
  finding that quietly does not appear. There is no CHECK constraint to catch it, by design: an
  unexpected value has to be storable rather than fatal.
- **A row left at the default is a row Network Intel is still waiting on**, and the import will never
  complete. If you insert a row you have already decided, stamp it.

#### What to write, and how much of it

`comparison_result` is the evidence behind the run: the pair, and how close it was. It is what
the results table renders and what the app counts matches from.

**Writing a row only for matches is supported, and is the minimum.** Network Intel will still be
correct: it takes the denominator ("5 of 12 matched") from the import's own rows, not from this
table, so a run that only stores its winners cannot report a 100% hit rate.

**Writing a row for _every_ name — matched or not, with its closest counterpart — is better**, and
is what the internal matcher does. It costs you nothing extra (you computed the closest name
already, to decide) and it buys the user the one question the matches alone can never answer:
*why didn't this person match?* With every row stored, the results table offers a view of the
near-misses; with only matches, that view does not exist and the table says so.

### c. Your verdict is the verdict

**Changed on 2026-07-20.** It used to be advisory, and the difference matters if you integrated
before then.

Previously `match` / `unmatch` meant only "this row is decided", and whether the *user* saw a match
was decided on our side by `matching_score >= 0.8`. A row you stamped `match` at `0.3` rendered
"No match" and was counted as one. That was deliberate: your bar and ours were different bars, and
letting each decide half the screen meant one row got answered two ways.

The score column is gone, and with it our half of that. **What you stamp is what the user sees**,
counted in the header, the tabs, Past runs and the row badge alike. There is no threshold on our
side any more and no second opinion — we cannot re-derive, re-check or disagree with your verdict,
because the only thing stored is the verdict itself.

Two obligations come with that:

- **Your threshold is now the product's threshold.** Loosening it moves every number Network Intel
  reports, immediately and invisibly. Nothing here will notice or warn.
- **A verdict, once written, is permanent.** Verdicts used to be recomputed on every read, so
  moving one constant re-judged the entire history. Now a run is judged when it is written. Getting
  a run wrong means re-running it, not fixing a number.

---

## 3. What Network Intel does not do

- **It does not call you back.** There is no callback for this path. (The
  `POST /api/callbacks/comparison-results` endpoint is for the *other*, HTTP-push matcher —
  [§4](#4-the-http-callback-path). If you write to the database directly, leave it alone.)
- **It does not retry.** If the workflow dies halfway, its rows stay unfinished and the
  import stays unfinished, visibly, until someone intervenes. That is the intended failure
  mode: a stuck import is a fact, and hiding it behind a timeout would turn a visible problem
  into a silent wrong answer.
- **It does not ask you to clean the names.** It already cleaned them, at import, and the CSV
  carries the cleaned, lower-cased result in the one name column there is. Match on what you
  are given — it is what the internal matcher matches on, and no other spelling is stored.
- **It does not retry a failed send by itself.** The import forwards its rows inside the
  import request; if the webhook rejects the file or times out (30 s), the import and its run
  are marked `failed`, loudly. `POST /api/comparisons/:id/send-webhook` re-sends the stored
  rows on demand and, on success, puts the import and its run back to `processing`.

---

## 4. The HTTP callback path

The other matcher. Instead of writing to `comparison_result` yourself, you `POST` batches of
results to `/api/callbacks/comparison-results` and Network Intel writes them. It is a separate path
with a separate audience; if you are here for the direct-DB contract above, everything in this
section is somebody else's problem.

```jsonc
POST /api/callbacks/comparison-results
X-Callback-Token: <CALLBACK_TOKEN>

{
  "session_id": "12",          // the comparison (run) id
  "batch_number": 1,
  "total_batches": 3,          // 0 / omitted => "unknown"
  "is_complete": false,        // BATCH flag — see below
  "results": [
    {
      "fb_name": "preecha wong",
      "person_name_en": "preecha wong",
      "person_name_th": "ปรีชา วงศ์",
      "status": "match"        // REQUIRED IN PRACTICE — see below
    }
  ]
}
```

**`is_complete` (batch level) is unchanged.** It still means "no more batches after this one",
it still defaults to `false` when omitted, and it is still load-bearing: it is one of the two
ways a callback-driven run reaches `completed` (the other being the received batch count reaching
`total_batches`). The 2026-07-17 migration **did not touch it** — what it dropped was the
`comparison_result.is_complete` *column*, which stored this batch flag against individual rows and
never described them. Same word, two layers; only the column is gone.

> ### ⚠️ Breaking, 2026-07-20 — `status` is now the only thing that decides a match
>
> **If your integration posts scored rows without a `status` field, every one of them is now
> recorded as *unmatched* and your runs will report zero matches.**
>
> The schema still accepts the field's absence, so nothing errors — which is precisely why this
> is called out here rather than left to a 400. Add `status` to every item before this ships.

**`status` (per result item)** carries the same vocabulary as everywhere else in this document:
`pending` / `processing` mean unfinished, `match` (or `matched`) means matched, `unmatch` means no
match, and **anything unrecognised means no match**.

**Omitting it now means `unmatch`.** It used to mean "decided, derive it from the score" — a fair
reading while a score existed, since a matcher posting a scored result has by definition finished
with it. There is no score to derive from, and of the two possible defaults this is the recoverable
one: a real match filed as unmatched is a missed introduction, while a stranger filed as a match is
a bad introduction made in the user's name.

**`matching_score` is no longer read.** Send it if you like — unknown keys pass through into
`extra` and it will show up as an extra column in the results table — but it decides nothing. As in
[§2c](#c-your-verdict-is-the-verdict), `status` is the verdict now; there is no second opinion
behind it.

Anything else in a result item is preserved into `extra` (`jsonb`) rather than dropped. The
schema is lenient by design — numbers are coerced, names may be null, unknown keys pass through —
so a callback from a service we cannot test against is never rejected over a cosmetic mismatch.
