# The external matcher workflow

How Network Intel hands a run to the workflow, and what the workflow must do with it.

This is a **contract between two systems that share one database**. Network Intel does not receive
the results over HTTP — it reads them out of Postgres, by polling. So every promise below is
about a table, not an endpoint.

---

## Turning it on

Nothing in this document takes effect until **`EXTERNAL_MATCHER=1`** is set on the API.

With the flag off (the default), Network Intel behaves exactly as it always has: pressing
**Compare** scores the names itself, in Postgres, and returns the run immediately. That path
is untouched and still works — the flag chooses which matcher runs, and both remain.

The columns this document depends on are part of [`schema-redesign.sql`](schema-redesign.sql), so a
database built from it is ready as-is. A database created from an *older* schema needs the drift
files applied by hand — [`add-comparison-scope.sql`](add-comparison-scope.sql) is the one this
release needs, and the app never issues DDL (`DB_SKIP_MIGRATE=1`), by design.

> ### ⚠️ Coordinate first — `X-Value-Encoding: percent`, and Thai companies work at all, 2026-08-06
>
> **Every company-scoped comparison on the live database was a 500, and none of them reached you.**
> A header value is a ByteString — bytes 0–255, one per character — and `X-Filter-Value` carries a
> company name. `ก` is U+0E01 = 3585, so `fetch` threw
> `TypeError: Cannot convert argument to a ByteString ... value of 3585` while serialising the
> headers, before anything left the process. All 1000 distinct company names on file are Thai. The
> run was rolled back and the user saw "Internal Server Error"; you saw nothing, because nothing was
> sent. Owner scopes escaped only because the one owner on file is spelled in ASCII.
>
> **The three headers carrying free text may now arrive percent-encoded**, and one new header says
> when they have:
>
> | Header | |
> |---|---|
> | `X-Value-Encoding` | `percent` when `X-Filter-Value`, `X-Compare-Sources` and `X-Compare-Companies` are encoded. **Absent means they are not.** |
>
> **What you must do — one branch, three headers:**
>
> ```
> split the header on the literal "|", then URL-decode each part
>   ... if X-Value-Encoding == "percent"
> ```
>
> Encoding is **all three or none**, decided per request, so you never have to ask which of them it
> applied to. `X-Filter-Value` is a one-element list, so the same two lines read all three. The
> other four headers are enum values and ids and are **never** encoded.
>
> **Requests with nothing to encode are byte-identical to before and carry no marker**, so the runs
> working today keep working whether you implement this or not. It is the previously-broken ones —
> every Thai company — that need it.
>
> **If you do not implement it, those runs stay at `processing`.** `%E0%B8%81...` matches no
> `company_name`, you select nothing, and selecting nothing is not an error anywhere: the run sits
> unfinished rather than coming back wrong. Loud, and by choice — but it does mean **a Thai company
> comparison does not work until this ships on your side.**
>
> **A `|` inside a value now forces encoding too, on runs with no Thai in them at all.** `|` is the
> list separator, so a company genuinely named `Gulf | Trading` was arriving as two companies that do
> not exist. Encoded per element, the separator means one thing and the pipe survives.

> ### 🛑 BREAKING — THE CSV IS GONE. The request is its headers, 2026-08-05
>
> **Stop parsing the request body. There isn't one.** Every request on this page — imports
> included — is now a `POST` with `Content-Length: 0` and no `Content-Type`. What used to be a
> `multipart/form-data` file part carrying up to 100,000 rows is seven headers, and a
> 100,000-row import is byte-for-byte the same request as a two-row one.
>
> **For most integrations this is close to a no-op, and that is the point.** You already select
> what to match with `WHERE upload_id = :session_id`. The file was a stale copy, built at cost, of a
> table you were about to query anyway — and two of the bugs recorded further down this page are
> that copy drifting from the table it copied. What you were ignoring has stopped being sent.
>
> **What you must change:**
>
> | Was | Is now |
> |---|---|
> | `X-Upload-ID`, `X-Session-ID` | **gone** — use `X-Filter-Value` (it is the upload id on an import) |
> | `X-Compare-By` | **gone** — read `X-Compare-Type` and `X-Compare-Language`, as this page always asked |
> | `X-Row-Count` | **gone** — count your own selection; there is no download to verify |
> | any CSV column | **gone** — every one of them is a column of the row you are selecting anyway |
>
> **The one genuinely new obligation is on the friends side**: `X-Compare-Sources` is now sent on
> BOTH webhooks. It used to be company-only, which meant an owner-scoped run narrowed to LinkedIn
> went out unnarrowed and came back matched against every source, with the run's own page labelling
> it "LinkedIn". `X-Compare-Companies` is the new mirror of it. Both are absent when nothing was
> narrowed, so ignoring them behaves exactly as today for unnarrowed runs.
>
> **`comparison_result.upload_name` is the one write that changes.** It was filled from the CSV's
> `upload_person_name` column. Read it off `friend.relationship_owner` on the row you selected — the
> same fact, from the place it is authoritative. See the 2026-07-30 note in [§2b](#b-the-result-if-it-matched)
> for what happened the last time this column was sourced from the wrong place.

> ### ✅ No action needed — duplicate rows are dropped at import again, 2026-08-05
>
> **This reverses the "imports STACK" note of 2026-08-04, which is deleted rather than amended
> because following it would now be wrong.** For one day Network Intel wrote every row of every
> import, duplicates included, so that a re-imported person landed under the new `upload_id` where
> your query could reach them.
>
> The reasoning was sound and the fix was not: it wrote a complete second copy of a 40,000-row file
> to solve a query problem. The query problem is solved properly now — you are pointed at rows
> rather than handed a copy of them — so the duplicate write has no job left to do.
>
> **What this means for you: nothing you can observe, except size.** A re-import of a file you
> already hold selects fewer rows, or none. An import that would write nothing at all is refused
> before it reaches you, so you will not be handed an empty job.
>
> A row is a duplicate only if it is identical **including the importer**: two colleagues who both
> have the same contacts each keep their own copy, and a row carrying a spelling the stored row
> lacks is not a duplicate and is written.

> ### ✅ No action needed — imports are always `en_full`, 2026-08-05
>
> The import screen's "How to compare" picker is gone. Every import-driven run sends
> `compare_type=full`, `compare_language=en` — always, on both directions.
>
> **Do not hard-code that.** The headers are still sent on every request and still vary, because a
> comparison started from the Network page ([§1c](#c-the-run-scope)) picks its own mode and is now
> the only source of `th_*` and of `*_name` / `*_surname` runs. A workflow that started ignoring
> `compare_language` on the grounds that imports are always English would answer every one of those
> with the wrong question, silently.

> ### ⚠️ Coordinate first — `filter_by` / `filter_value` decide WHERE THE ROWS COME FROM, 2026-08-05
>
> Every request carries `X-Filter-By` and `X-Filter-Value`, and **they are the instruction**: they
> name which rows you are being asked to score. See [§1c](#c-the-run-scope).
>
> A workflow that ignores them selects nothing, stamps nothing, and the run sits unfinished until
> somebody looks. That is the failure mode we want — visible, not silent — but it means **no run of
> any kind works until your side reads these keys.**
>
> **One new obligation: `UPDATE lakeshore.comparison SET status = 'completed' WHERE id = :comparison_id`
> when you finish a run whose `filter_by` is NOT `upload`.** We cannot work it out. For an import we
> count that import's unstamped rows and close the run when none are left ([the flow](#the-flow)); a
> scoped run has no such row set, because deciding what it covers is exactly what was delegated to
> you.

> ### ⚠️ Coordinate first — `compare_by` decides what "match" means, 2026-07-27
>
> **A workflow that ignores the mode does not fail — it answers a different question and reports the
> answer as though it were the right one.** A run the user configured as "last name, Thai" comes
> back full-name-matched, the results table labels it "Last name · Thai", and nothing anywhere
> disagrees. That is invisible from our side: we see your verdicts, not your matching.
>
> **There is no "compare both languages" mode.** `either` existed until 2026-07-27 and was the
> default; it scored a name against both of a contact's spellings and kept the better. It is gone.
> **Every run compares exactly one language**, and the default is `en_full`. A friends list holding
> both scripts takes two runs, one per language, and each reports the other language's names as
> unmatched rows that Network Intel renders as "Not compared".

> ### ⚠️ Breaking change — `comparison_result.is_complete` is gone
>
> The column was **dropped** from `comparison_result` and `status` added in its place. Any workflow
> whose `INSERT` names `is_complete` fails with
> `ERROR: column "is_complete" of relation "comparison_result" does not exist`. There is no
> compatibility window, because a dropped column has no reads left to serve.
>
> This does **not** affect the `is_complete` field on the HTTP callback body, which is a different
> thing that survives untouched — see [§4](#4-the-http-callback-path).

**`COMPANY_WEBHOOK_URL` and `FACEBOOK_WEBHOOK_URL` are required with the flag on.** The
webhook is the pipeline in this mode, so an import is refused up front (503, nothing stored)
if its URL is missing.

---

## The flow

```
user imports a file
        │
        ▼
Network Intel  ─── writes rows to friend / company_contact, each status='processing'
          ─── creates one `comparison` row (status='processing')  ← this is the run
          ─── POSTs seven headers and NO BODY, naming which rows the run covers
        │
        ▼
workflow  ─── SELECTS those rows out of Postgres itself
          ─── matches each against the opposite table
          ─── writes comparison_result rows  (the pair + the verdict)
          ─── stamps each source row  status = 'match' | 'unmatch'
        │
        ▼
Network Intel  ─── polls: "does this upload still have unfinished rows?"
                     ('pending' or 'processing' — both mean no verdict yet)
          ─── when none do: upload → 'completed', comparison → 'completed'
          ─── the user, who has been watching the Compare page, sees the results
```

The last step is **imports only** (`filter_by=upload`). Every other run is closed by you — see
[§1c](#c-the-run-scope).

A **friends** selection is matched against every contact in `company_contact`.
A **company** selection is matched against every friend in `friend`.

---

## 1. What Network Intel sends

`POST` to `FACEBOOK_WEBHOOK_URL` (the friends side) or `COMPANY_WEBHOOK_URL` (the company side),
with **no body**. Everything is in the headers.

**Headers**

| Header | Meaning | Sent |
|---|---|---|
| `X-Comparison-ID` | The **run** id. **Write `comparison_result.comparison_id` with this.** | always, except on an ingestion-only notice (see below) |
| `X-Filter-By` | `upload` \| `company` \| `owner` \| `file` — **which rows.** | always |
| `X-Filter-Value` | The one value that axis takes. | always |
| `X-Compare-Type` | `full` \| `name` \| `surname` — **which part of the name to compare.** | always |
| `X-Compare-Language` | `en` \| `th` — **which language to compare in.** | always |
| `X-Compare-Sources` | Restrict `friend.source` to these, pipe-separated (`facebook\|linkedin`). | only when narrowed |
| `X-Compare-Companies` | Restrict `company_contact.company_name` to these, pipe-separated. | only when narrowed |
| `X-Value-Encoding` | `percent` — **the three free-text headers above are percent-encoded.** | only when needed |

**Five that are always there, and two that mean "no restriction" by being absent.** That asymmetry
is deliberate. A missing mode or a missing scope has no safe reading — you would have to guess, and
the guess that looks harmless is precisely the wrong answer. A missing narrowing has exactly one
reading, and it is what every run did before the header existed.

`X-Comparison-ID` is omitted in one case: `EXTERNAL_MATCHER` is off and the request is a pure
ingestion notice, because Network Intel scored the names itself and there is no run to write into.
Omitted rather than blank — "there is no run" is a state you can act on, where `X-Comparison-ID: ""`
looks like a run whose id happens to be empty.

### The two narrowings

One rule covers both: **apply it to the table it names.**

That reads two different ways depending on which webhook you are on, and both fall out of the same
sentence without a branch:

- On the **company** webhook you select contacts, so `X-Compare-Companies` narrows your SELECTION
  and `X-Compare-Sources` narrows the friends you match them against.
- On the **friends** webhook you select friends, so `X-Compare-Sources` narrows your SELECTION and
  `X-Compare-Companies` narrows the contacts you match them against.

Match both **case-insensitively**. The values we send are already folded and sorted; the columns
themselves are free text and the Database console writes them too, so `Facebook` and `facebook` are
both on rows.

**Pipe-separated, not comma-separated.** Both axes are free text a user can enter: a source may be
`trade show, bangkok` and a company is routinely `Wire Demo, Inc.`, so a comma inside a value would
leave you unpicking quoting from list syntax in one string.

**The failure mode is the `compare_by` one.** Ignoring a narrowing does not error — the run comes
back wider than the question asked, its page labels it with the narrowing anyway, and its counts are
quietly wrong. We cannot detect it: we see your verdicts, not your candidate set.

### Reading a free-text header

`X-Filter-Value`, `X-Compare-Sources` and `X-Compare-Companies` are the three headers carrying words
a user typed. All three are read the same way:

```
parts = header.split("|")
if X-Value-Encoding == "percent":
    parts = [url_decode(p) for p in parts]
```

`X-Filter-Value` is a **one-element list**, so those two lines cover it too and there is no second
rule to remember. The other four headers are enum values and ids — never encoded, never split.

**Why encoding exists at all: a header cannot hold Thai.** A header value is a ByteString, one byte
per character, and `ก` is U+0E01 = 3585. Sending it raw is not a formatting compromise, it is a
`TypeError` on our side before the request is built — which is precisely what happened to every
company-scoped run on the live database until 2026-08-06.

**Absent means the values are literal**, and a request with nothing to encode is byte-identical to
one sent before this header existed. So the encoding path is only ever exercised by runs that could
not previously be sent at all.

**Decode before you fold or compare.** `lower('%E0%B8%81')` is not the company anyone named. If you
skip the decode, you select zero rows and the run stays at `processing` — visibly unfinished, which
is the failure this contract prefers, but unfinished all the same.

**Encoding is per element, so the separator is always literal.** A value containing `|` arrives as
`%7C` and a run whose values are otherwise plain ASCII is encoded for that reason alone — a company
named `Gulf | Trading` is one company, and splitting first then decoding keeps it that way.

### b. The comparison mode

Two independent axes. `compare_by` as a single value is **gone from the wire** — it was the two
joined, and this page always told you to read the two.

| The run's stored `compare_by` | `X-Compare-Type` | `X-Compare-Language` |
|---|---|---|
| `en_full` | `full` | `en` |
| `en_name` | `name` | `en` |
| `en_surname` | `surname` | `en` |
| `th_full` | `full` | `th` |
| `th_name` | `name` | `th` |
| `th_surname` | `surname` | `th` |

**`compare_type` — how much of each name to score.** Names are stored whole and already cleaned;
split on whitespace.

- `full` — the whole string.
- `name` — the first token (the given name).
- `surname` — the last token. **When a name has three or more tokens, also score the last two
  joined, and keep whichever scores higher.** That is how a two-word surname ("ณ อยุธยา", "del
  Carmen Garcia") is handled without anyone having to decide where the surname begins. Do not
  apply the two-token reading to a two-token name — it would be the whole name, and `surname` would
  quietly become `full` for the commonest shape there is.

**`compare_language` — which spelling to score on each side.**

- `en` — `person_name_en` on the contact, `friend_name_en` on the friend.
- `th` — `person_name_th` on the contact, `friend_name_th` on the friend.

Both tables have one column per language. A row may have **one** of the two empty; that is normal
and means we hold only one spelling for that person. A row with BOTH empty cannot occur — it is what
the import gate drops on.

A row with nothing in the run's language cannot be scored. **Stamp it `unmatch` anyway** — it is
finished, and leaving it `processing` hangs the run forever. Network Intel renders those as
*"Not compared"* rather than *"No match"*, working it out from the stored columns.

**If you receive a `compare_type` or `compare_language` you do not recognise, fail the row loudly**
(`status = 'fail'`) rather than falling back to whole-name matching. A failed row is visible in the
UI and someone will act on it; a silently full-name-matched row is indistinguishable from a correct
one.

### c. The run scope

**Two headers, and the pair that tells you what to DO rather than how to do it.**

| `X-Filter-By` | `X-Filter-Value` is | You select | Who closes the run |
|---|---|---|---|
| `upload` | an `upload.id` | that import's rows | **us** |
| `company` | a company name | contacts at that company | **you** |
| `owner` | a `friend.relationship_owner` | that person's friends | **you** |
| `file` | an `upload.id` | that import's rows | **you** |

```sql
-- Which TABLE is the URL you were called on, always:
--   FACEBOOK_WEBHOOK_URL → lakeshore.friend
--   COMPANY_WEBHOOK_URL  → lakeshore.company_contact

-- filter_by = 'upload' or 'file'
SELECT * FROM lakeshore.friend WHERE upload_id = :filter_value;
-- filter_by = 'owner'
SELECT * FROM lakeshore.friend WHERE lower(relationship_owner) = lower(:filter_value);
-- filter_by = 'company'
SELECT * FROM lakeshore.company_contact WHERE lower(company_name) = lower(:filter_value);
```

Match `filter_value` **case-insensitively** for `company` and `owner`: a company name keeps its
file's capitalisation and an owner keeps the one a human typed, so both are stored unfolded. For
`upload` and `file` it is an id — compare it exactly.

**`upload` and `file` are the same query.** That is not an oversight and they are not being merged:
they differ in the one thing you cannot derive, which is who marks the run `completed`. An import's
rows are a set we wrote and can therefore count down to zero; a `file` re-run covers rows nobody is
tracking, so we would be guessing between "still working" and "finished with nothing to say", and we
do not guess.

**`file` names ONE IMPORT, not a source type.** "Every LinkedIn friend" is `X-Compare-Sources`,
which is a different axis.

**Which table a `file` scope means is decided by the import, not by you** — but you do not have to
work it out: we send it to the webhook for the side it selects. A `file` scope arriving at
`FACEBOOK_WEBHOOK_URL` selects `friend`; one arriving at `COMPANY_WEBHOOK_URL` selects
`company_contact`. Same for `owner` (always friends) and `company` (always contacts).

#### You must close every run that is not an import

```sql
UPDATE lakeshore.comparison SET status = 'completed', updated_at = now()
 WHERE id = :comparison_id;
```

The run stays `processing` until you say otherwise, and the user sees a run that is still going.
That is the visible failure this codebase prefers to a silent wrong answer.

### The five things that reach you

| Webhook | Started by | `X-Filter-By` | `X-Filter-Value` |
|---|---|---|---|
| friends | a friends import | `upload` | the new `upload.id` |
| friends | "compare this owner" | `owner` | a `relationship_owner` |
| company | a company import | `upload` | the new `upload.id` |
| company | "compare this company" | `company` | a company name |
| either | "compare this past import" | `file` | that `upload.id` |

The last routes by what the import wrote: a friends import's `file` scope arrives on the friends
webhook, a company import's on the company one.

### The request, in full — an owner-scoped run

```http
POST /facebook HTTP/1.1
host: wf.promptxai.com
x-comparison-id: 41
x-filter-by: owner
x-filter-value: Mint
x-compare-type: surname
x-compare-language: th
x-compare-sources: linkedin
content-length: 0

```

That is the whole request. Select `friend` where `lower(relationship_owner) = lower('Mint')` and
`lower(source) = 'linkedin'`, score every row against `company_contact` under `th_surname`, write
your `comparison_result` rows against comparison 41, stamp each `friend.status`, then mark
comparison 41 `completed`.

### The request, in full — a company import

```http
POST /company HTTP/1.1
host: wf.promptxai.com
x-comparison-id: 12
x-filter-by: upload
x-filter-value: 22
x-compare-type: full
x-compare-language: en
content-length: 0

```

Select `company_contact` where `upload_id = 22`, score each against every friend on file under
`en_full`, write your rows against comparison 12, stamp each `company_contact.status`. **Do not**
mark comparison 12 completed — we will, when none of upload 22's rows are unfinished.

### What you read off the rows

Everything the CSV used to carry is a column of the row you just selected. `uuid` was
`company_contact.id` on one side and `friend.id` on the other; it is now just `id` on the table you
queried, and the cross-direction confusion that produced a live foreign-key failure is not
expressible.

Two that are worth naming, because they are the ones people get wrong:

- **`friend.relationship_owner`** → `comparison_result.upload_name`. This is the person whose
  relationship the friend is. It arrived as `upload_person_name` on the old CSV.
- **`upload.uploaded_by`** is a DIFFERENT PERSON — whoever performed the import. An assistant
  importing on a salesperson's behalf is the case that split them. Writing the importer into
  `upload_name` re-files every contact under whoever pressed the button, and nothing errors.

**The names are already cleaned and lower-cased.** Titles, suffixes and nicknames are stripped at
import, before the row is stored — `Mr. Somchai Jaidee` is stored as `somchai jaidee` and
`นายสมชาย ใจดี` as `สมชาย ใจดี`. Middle names are **kept**. Match on the stored column: it is the
only spelling there is, and it is exactly what the internal matcher matches on.

`company_name` is the exception: **tidied only** (whitespace and invisible characters), not cleaned
and not lower-cased. Its capitalisation is the file's own. Match it case-insensitively.

`status` reads `processing` on every row you select, because that is what it is. It is the column
you are being asked to change, not one that tells you anything.
---

## 2. What the workflow must write

For **every row it is given** — including the ones that match nobody.

### a. The verdict, on the source row

```sql
UPDATE lakeshore.friend           -- or lakeshore.company_contact
   SET status = 'match',          -- or 'unmatch'
       updated_at = now()
 WHERE id = :id;                  -- the row's own id, from the row you selected
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
  (comparison_id, friend_name_en, friend_name_th, person_name_en, person_name_th,
   batch_number, status, upload_name, company_name, extra)
VALUES
  (:comparison_id,      -- from X-Comparison-ID
   :friend_name_en,     -- the Facebook side of the pair, English spelling
   :friend_name_th,     -- the Facebook side of the pair, Thai spelling
   :person_name_en,     -- the company side
   :person_name_th,
   1,
   'match',             -- or 'unmatch'. THE VERDICT. See the vocabulary below.
   :uploaded_by,        -- who imported the friend, when known
   :company_name,       -- where the matched contact works, if you know it; NULL is fine
   NULL);
```

> **BREAKING, 2026-08-03: `friend_name` is gone, and naming it will fail the write.** It held the
> single spelling you scored. Put that name in `friend_name_en` or `friend_name_th` instead —
> whichever language it is in — and send both when you have both. At least one is required in
> practice: a row naming neither cannot be attributed to a friend and will contribute to no count
> on any page, though the INSERT itself will succeed.
>
> If you are not ready to tell the two apart, file by script: a name containing Thai characters
> (U+0E00–U+0E7F) goes in `friend_name_th`, anything else in `friend_name_en`. That is precisely
> what we did to your existing rows in
> `api/docs/migrations/2026-08-03b-backfill-comparison-result-friend-names.sql`, so following it
> keeps new rows consistent with the ones already on file.
>
> **The HTTP callback path ([§4](#4-the-http-callback-path)) is NOT affected** — it still takes
> `fb_name` and files it by that same rule on our side. Only this direct `INSERT` changes.

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

`extra` (`jsonb`) is there for any non-standard fields you want to keep — unchanged, and NULL is a
perfectly good value for it.

**Two optional columns, added 2026-07-28. Both nullable; an `INSERT` that omits them is still
valid** — this is an appended ask, not a new requirement.

> ### ⛔ THE TWO ID COLUMNS ARE NOT INTERCHANGEABLE — read this before filling either
>
> **This used to say "`friend_id` ← the CSV's `uuid`" with no qualification, and that was only true
> on the friends side.** It caused at least one live failure and it was our defect, not yours. The
> CSV is gone and with it the ambiguous `uuid`, but the rule it got wrong still has to be stated:
>
> | You were called on | You selected from | That row's `id` goes in | The OTHER id |
> |---|---|---|---|
> | `FACEBOOK_WEBHOOK_URL` | `friend` | `friend_id` | `company_contact_id` ← the contact you matched |
> | `COMPANY_WEBHOOK_URL` | `company_contact` | `company_contact_id` | `friend_id` ← the friend you matched |
>
> Each id belongs in the column named after its own table. That is now the whole rule, and it is why
> selecting the rows yourself is safer than being handed them: there is no single `uuid` field whose
> meaning depends on which request you are answering.
>
> **Never put `comparison_id` or `filter_value` in either column.** They are ids of a `comparison`
> and an `upload`, they are small integers from different sequences entirely, and nothing stops them
> looking plausible next to a row id. The symptom is:
>
> ```
> ERROR: insert or update on table "comparison_result" violates foreign key constraint
>        "comparison_result_company_contact_id_fkey"
> DETAIL: Key (company_contact_id)=(8) is not present in table "company_contact".
> ```
>
> — where `8` was an `upload.id`. The FK is what caught it, and that is the constraint doing its
> job: a wrong id here does not error at read time, it silently attributes a match to the wrong
> person and mis-counts a roster.
>
> **If in doubt, send NULL for both.** They are optional and always have been; we resolve the friend
> back by owner plus either name spelling when they are absent. A run that omits them is correct and
> complete — filling them makes the resolution exact rather than resolved, which is worth having but
> is never worth a guess.

| Column | Write it with | Why it helps |
|---|---|---|
| `friend_id` | the friend's `friend.id` | Exactness |
| `company_contact_id` | the contact's `company_contact.id` | Exactness |

`friend_name_en` / `friend_name_th` were on this list too. They are no longer optional-in-effect:
since `friend_name` was dropped on 2026-08-03 they are the only place a friend's name can go.

The counting problem they solve is worth stating, because it is invisible from your side. A friend
now has two spellings. If a Thai run writes `สมชาย ใจดี` and an English run writes `somchai jaidee`
for the same person, and the row carries nothing else, then counting distinct names sees **two
friends** where there is one — and the app reports a roster as more completely placed than it is.

We do not depend on you for this: where these columns are absent we resolve the friend back by
owner plus either spelling, which needs only one of the two names to be right. Filling them makes
it exact instead of resolved, and costs you one column you already have in hand.

`friend_id` and `company_contact_id` are for **identity and counting only**. We never render a name
by following one — the text columns beside them are the frozen record of what the run compared, and
resolving a display name through an id is how a later rename would start rewriting history.

**Both are real foreign keys** (`ON DELETE SET NULL`), so an id that names no row fails the `INSERT`
outright rather than being stored. That is deliberate and it is not going to be relaxed: an id
pointing at the wrong row cannot be detected afterwards — it produces a match attributed to
somebody who was never compared, and a roster that reads as more completely placed than it is. A
failed write is a bad row you can see; a stored wrong id is a bad answer nobody can.

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
- **It does not ask you to clean the names.** It already cleaned them, at import, and the stored
  column holds the cleaned, lower-cased result. Match on the column you select — it is what the
  internal matcher matches on, and no other spelling is stored.
- **It does not send you the rows.** It sends you a pointer to them. Everything you need is a
  column of the row you select, so a request that told you *about* the data would only be a second
  copy of it, generated at cost and stale the moment anything is edited between the two.
- **It does not keep an import you never accepted.** The notification goes out inside the import
  request. If you reject it or do not answer within 30 s, the whole import is unwound before that
  request returns — its rows are deleted, the run it opened is deleted, and it leaves no entry on
  the Uploads page. The caller gets a `502`, and it means *nothing was imported*.

  This is the one place where "loudly" was not enough. The rows were already in the cumulative
  tables by the time you were asked, so an import marked `failed` and left in place put friends and
  contacts into every later dedup, roster and count while permanently awaiting a verdict from a
  workflow that was never told to decide anything.

  Two consequences worth knowing:
    - There is no failed import to retry. `POST /api/comparisons/:id/send-webhook` still exists and
      still re-points you at an import's rows on demand, but reaching a failed send now means
      uploading the file again.
    - A request carrying **both** a company file and a friends file imports each separately. If the
      first handover succeeds and the second fails, only the second is unwound — the first is
      already yours, and deleting rows you are working on would strand you mid-run.

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
