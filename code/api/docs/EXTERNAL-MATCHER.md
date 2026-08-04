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

> ### ⚠️ Coordinate first — `compare_sources` narrows a COMPANY import's friend pool, 2026-08-03
>
> Company imports gain a **`compare_sources`** CSV column and a matching **`X-Compare-Sources`**
> header. It names which friends the contacts in this import should be matched against, by
> `friend.source` — `facebook`, `linkedin`, `business card`, or a value the user added.
>
> **Pipe-separated (`facebook|linkedin`). Absent header, or an empty cell, means EVERY source** —
> which is what every run did before this existed, so a workflow that ignores it behaves exactly as
> it does today for unscoped runs.
>
> **The failure mode is the `compare_by` one again: ignoring it does not error.** A run the user
> scoped to LinkedIn comes back matched against every friend on file, the run's own page labels it
> "LinkedIn", and its counts are quietly wider than the question asked. We cannot detect this — we
> see your verdicts, not your candidate set.
>
> Match `friend.source` **case-insensitively**. The values we send are already folded and sorted;
> the column itself is free text and the Database console writes it too, so `Facebook` and
> `facebook` are both on rows.
>
> **Social imports do NOT get this column, and that is not an oversight.** A friends import hands
> you the exact rows to match, all of them carrying one `type` — there is no pool to narrow. Only
> the company direction matches against a set it was not given.
>
> Additive and appended last, so reading it is safe today and a positional parser is unaffected.

> ### ⚠️ Coordinate first — `compare_by` decides what "match" means, 2026-07-27
>
> The CSV gains **`compare_type`**, **`compare_language`** and **`compare_by`** columns, and the
> request gains the matching **`X-Compare-Type`**, **`X-Compare-Language`** and **`X-Compare-By`**
> headers. They carry the run's comparison mode: which part of each name to compare, and which
> language to compare it in. See [§1b](#b-the-comparison-mode).
>
> **A workflow that ignores it does not fail — it answers a different question and reports the
> answer as though it were the right one.** A run the user configured as "last name, Thai" comes
> back full-name-matched, the results table labels it "Last name · Thai", and nothing anywhere
> disagrees. That is the entire risk in this change, and it is invisible from our side: we cannot
> see your matching, only your verdicts.
>
> Unlike the `is_complete` break below, **this one can and should be fixed on your side first.**
> The columns are additive, appended after `comparison_id`, so reading them is safe today. The
> order is: teach the workflow to read `compare_type` and `compare_language` (and to fail loudly on
> a value it does not recognise), *then* the mode picker goes live.
>
> **There is no longer a "compare both languages" mode.** `either` existed until 2026-07-27 and was
> the default; it scored a name against both of a contact's spellings and kept the better, so a
> mixed-script file matched in one pass. It is gone. **Every run now compares exactly one
> language**, and the default is `en_full` — English, whole names. A friends list holding both
> scripts takes two runs, one per language, and each reports the other language's names as
> unmatched rows that Network Intel renders as "Not compared".
>
> The same release adds `uploader_name`, `type` and `relationship_owner`. Those are informational
> and safe to ignore — but read the note on `upload_person_name` in [§1](#1-what-networkintel-sends)
> before assuming you know which person it names.

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
| `X-Compare-Type` | `full` \| `name` \| `surname` — **which part of the name to compare.** Always sent. |
| `X-Compare-Language` | `en` \| `th` — **which language to compare in.** Always sent. |
| `X-Compare-By` | The two joined, `'<language>_<type>'`. Traceability; branch on the two above. |
| `X-Compare-Sources` | **Company imports only.** Which friends to match these contacts against, by `friend.source`, pipe-separated (`facebook\|linkedin`). **Absent means every source.** |

`X-Comparison-ID` is the important one: it is the only way the results you write can be
attached to the run the user is watching. `X-Row-Count` lets you size the job — and tell a
truncated download from a small import — without parsing the file first.

The three mode headers are always present, where `X-Comparison-ID` is omitted when there is no run.
That asymmetry is deliberate: "there is no run" is a state you can act on, but "there is no mode" is
not — you would have to guess, and the guess that looks harmless (whole names) is precisely the
wrong answer to send back for a run the user configured as a surname match.

**CSV columns — company import**

```
uuid,company_name,person_name_th,person_name_en,upload_person_name,status,session_id,comparison_id,uploader_name,type,compare_type,compare_language,compare_by,compare_sources
```

**CSV columns — social import**

```
uuid,fb_name,upload_person_name,status,session_id,comparison_id,relationship_owner,uploader_name,type,compare_type,compare_language,compare_by,friend_name_en,friend_name_th
```

The columns after `comparison_id` are new as of 2026-07-27, and `friend_name_en` / `friend_name_th`
as of 2026-07-28. All are **appended**, never interleaved, so a positional parser keeps working and
a header-keyed one gains keys it may ignore.

**`fb_name` is not going away on the CSV, and this release does not change it.** A friend used to
have one name; since 2026-07-28 they have a column per language, symmetric with the company side.
`fb_name` still carries the single name a one-spelling friend has — and the English one when both
exist — which is exactly what it always carried, so a workflow that ignores the two new columns
reads this CSV as it does today.

When you are ready, prefer them: branch on `compare_language` and score `friend_name_th` for `th`
and `friend_name_en` for `en`, instead of scoring `fb_name` against whichever contact column the
mode selected. That is the change that makes a mixed-script friends list matchable in one pass per
language rather than by inference from the characters. Tell us when you have, and `fb_name` goes.

> Note that the WRITE side moved ahead of this on 2026-08-03: the `comparison_result.friend_name`
> column you `INSERT` into is gone, replaced by `friend_name_en` / `friend_name_th`. What you READ
> here is unchanged. See [§2b](#b-the-result-if-it-matched).

A row may have **one** of the two columns empty. That is normal and not an error — it means we hold
only one spelling for that person. A row with BOTH empty cannot occur: it is what our import gate
drops on.

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
far more easily than a request header. `uploader_name`, `type`, `compare_type`,
`compare_language` and `compare_by` are repeated per row for the same reason and are likewise
constant across the file.

### The four people-and-provenance columns

Three of these are new and one changed what it points at without changing what it means. Read
this before wiring any of them up.

| Column | Per | What it is |
|---|---|---|
| `upload_person_name` | row (social) / file (company) | **The relationship owner** — unchanged in meaning. Write it to `comparison_result.upload_name`, as you always have. |
| `relationship_owner` | row | The same value under its honest name. Social imports only. |
| `uploader_name` | file | Who *performed* the import. **New, and not the same person.** |
| `type` | file | Where the data came from: `facebook`, `linkedin`, `business card`, or a value the user added. |

**`upload_person_name` still names the relationship owner.** Until 2026-07-27 it was sourced from
`upload.uploaded_by`, back when that column meant "the owner for this import"; it is now sourced
from `friend.relationship_owner`, which means the same thing per row. **If you write it to
`comparison_result.upload_name` today, keep doing exactly that** — the value is the same fact,
now correct on a file that carries several owners rather than collapsed to one.

**Do not switch that write to `uploader_name`.** It is a different person: an assistant importing
on a salesperson's behalf is the case that split the two. Writing the importer there re-files every
contact under whoever happened to press the button, and nothing errors.

`relationship_owner` is offered alongside the alias, not instead of it, so an existing workflow
needs no change and a new one can read the name that says what it means.

> **This happened, and the fix is on our side (2026-07-30).** A workflow did write `uploader_name`
> into `comparison_result.upload_name`. Because the product grouped every roster by that column,
> one wrong string broke three things at once and logged nothing: chips named the importer, the
> roster page behind them came back empty, and `count(distinct friend)` fell to zero — a company
> page reading "Connections 0" beside "Reachable by 1".
>
> **Network Intel no longer derives ownership from this column.** Rosters are keyed on
> `friend.relationship_owner`, resolved through the friend row each result names — by `friend_id`
> when you send one, otherwise by either name spelling. A result we cannot resolve to a friend row
> now has **no owner**: it produces no roster entry and no "known by" chip, rather than a chip
> naming somebody whose roster does not exist. The value you send still surfaces as plain text on
> the run tables and the results payload, where it is read as "what the matcher claimed" rather than
> as a fact about ownership.
>
> The request above is unchanged: **please still write the owner there.** It is what makes the
> resolution exact instead of a name lookup, and it is what the run tables show. But it is no longer
> load-bearing, so getting it wrong now costs precision rather than correctness.
>
> **The one thing worth adding, if you can:** send `friend_id`, straight from the `uuid` column of
> the CSV you were handed. It is the friend row's primary key, it removes the name lookup entirely,
> and it is immune to every spelling question on this page.

### b. The comparison mode

Two independent axes. **Read `compare_type` and `compare_language`; ignore `compare_by`** — it is
the two joined (`'<language>_<type>'`), sent so a support question about a run is answered by one
cell, and splitting it yourself is exactly the parsing that goes wrong quietly.

| `compare_by` | `compare_type` | `compare_language` |
|---|---|---|
| `en_full` | `full` | `en` |
| `en_name` | `name` | `en` |
| `en_surname` | `surname` | `en` |
| `th_full` | `full` | `th` |
| `th_name` | `name` | `th` |
| `th_surname` | `surname` | `th` |

**`compare_type` — how much of each name to score.** Names arrive whole and already cleaned; split
on whitespace.

- `full` — the whole string.
- `name` — the first token (the given name).
- `surname` — the last token. **When a name has three or more tokens, also score the last two
  joined, and keep whichever scores higher.** That is how a two-word surname ("ณ อยุธยา", "del
  Carmen Garcia") is handled without anyone having to decide where the surname begins. Do not
  apply the two-token reading to a two-token name — it would be the whole name, and `surname` would
  quietly become `full` for the commonest shape there is.

**`compare_language` — which spelling of a company contact to score against.**

- `en` — score against `person_name_en` only.
- `th` — score against `person_name_th` only.

There is no "both" any more. `either` was the default until 2026-07-27 and scored against both
columns, keeping the better; it is gone, so **every run compares exactly one language** and the
default is `en_full`.

It selects the **contact's** column, not the friend's. A friend has one name (a social export
carries a single `name` field), so there is no second spelling on that side to select between.
A Latin-script friend scored against `person_name_th` will match nothing, and that is the
expected outcome rather than an error — Network Intel renders those rows as *"Not compared"*,
distinct from *"No match"*, and does so from its own reading of the text.

The net effect, and how the UI describes it to the user: **`th` matches Thai names with Thai
names, `en` matches English with English.** Network Intel excludes the other language's friends
from the run rather than reporting them as unmatched, so those two statements describe the same
behaviour — the column-level wording above is the precise instruction for your `INSERT`, and the
language-level wording is what it amounts to. You are free to skip the mismatched rows outright
rather than scoring them; just stamp them (`unmatch` is right) so the import can finish.

**If you receive a `compare_type` or `compare_language` you do not recognise, fail the row loudly**
(`status = 'fail'`) rather than falling back to whole-name matching. A failed row is visible in the UI and someone will act
on it; a silently full-name-matched row is indistinguishable from a correct one.

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
x-compare-type: full
x-compare-language: en
x-compare-by: en_full
x-compare-sources: linkedin
content-type: multipart/form-data; boundary=----formdata-undici-056721390935

------formdata-undici-056721390935
Content-Disposition: form-data; name="file"; filename="company-22.csv"
Content-Type: text/csv

uuid,company_name,person_name_th,person_name_en,upload_person_name,status,session_id,comparison_id,uploader_name,type,compare_type,compare_language,compare_by,compare_sources
325,"Wire Demo, Inc.",ปรีชา วงศ์,preecha wong,Nadhee,processing,22,12,Nadhee,,full,en,en_full,linkedin
326,"Wire Demo, Inc.",สุดา ใจดี,suda jaidee,Nadhee,processing,22,12,Nadhee,,full,en,en_full,linkedin
------formdata-undici-056721390935--
```

`type` is empty here because a company import has no source type — the axis describes where a
*friends* list came from. An empty cell is the normal case on this side, not a missing value.

**`type` and `compare_sources` are different facts and this row shows why they must not be
conflated.** `type` is empty (these are contacts; they came from no roster) while `compare_sources`
says `linkedin` — the user asked for these two contacts to be matched against their LinkedIn
friends and nobody else. Match `friend.source` against that list, case-insensitively; had the cell
been empty, every friend would be a candidate.

And a social import of two friends:

```http
POST /facebook HTTP/1.1
host: wf.promptxai.com
x-upload-id: 23
x-session-id: 23
x-comparison-id: 13
x-row-count: 2
x-compare-type: surname
x-compare-language: th
x-compare-by: th_surname
content-type: multipart/form-data; boundary=----formdata-undici-012377751986

------formdata-undici-012377751986
Content-Disposition: form-data; name="file"; filename="facebook-23.csv"
Content-Type: text/csv

uuid,fb_name,upload_person_name,status,session_id,comparison_id,relationship_owner,uploader_name,type,compare_type,compare_language,compare_by
1320,preecha wong,Mint,processing,23,13,Mint,Nadhee,facebook,surname,th,th_surname
1321,สุดา ใจดี,Nadhee,processing,23,13,Nadhee,Nadhee,facebook,surname,th,th_surname
------formdata-undici-012377751986--
```

This one is worth reading closely — it is the shape the new columns exist for:

- **The two rows have different owners, from one file.** Row 1320 is Mint's contact, row 1321 is
  Nadhee's, and `uploader_name` says Nadhee uploaded both. That is the assistant case. Match each
  row and write `comparison_result.upload_name` from `upload_person_name` / `relationship_owner`
  **per row** — a workflow that reads the owner once from row 1 and applies it to the file will
  file Mint's contacts under Nadhee.
- **`compare_type` is `surname` and `compare_language` is `th`**, so score `fb_name`'s last token
  against `person_name_th`'s last token — nothing against `person_name_en`.
- **Row 1320 has no Thai text**, so under this mode there is nothing to compare it with. Score it
  against nobody and stamp it `unmatch` (it is finished — leaving it `processing` hangs the
  import forever). Network Intel will show it as *"Not compared"* rather than *"No match"*,
  working that out from the text itself.

Things worth reading twice:

- **It is a file part, not a request body.** One part, named `file`, `text/csv`, with a `.csv`
  filename. Read it the way you would read an uploaded attachment. A raw `text/csv` body is what
  this *used* to send, and Fastify answered every one of them with `415`.
- **The boundary is generated per request.** Never hard-code it — parse the `content-type`.
- **Quoting is RFC 4180.** A field is quoted only if it holds a comma, a double-quote or a
  newline; an embedded double-quote is doubled (`""`). `"Wire Demo, Inc."` above is real output,
  not an illustration. A naive `split(",")` tears that row in half — use a CSV parser.
- **Quoting bites on `company_name` and the person columns (`upload_person_name`,
  `relationship_owner`, `uploader_name`), not on the names.** Cleaning
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
- **The rows are the new ones AND the enriched ones** (amended 2026-07-28; it was new-only).
  Duplicates were dropped at import, so a 500-row file that is 480 rows you already have arrives as
  20 rows. Since friends gained a column per language, a 21st kind of row can appear: a friend
  already on file who just gained the spelling they were missing. They carry matchable data no
  previous run has ever seen, so they are sent alongside the new rows and their `status` is reset to
  `processing` for you to stamp.

  A consequence worth knowing: **an import that adds no rows can now still send a request**, where
  before "an import that adds nothing sends no request at all" was unconditional. An import that
  changes nothing at all — no new rows, no filled spellings — still sends nothing and opens no run.

  You cannot tell an enriched row from a new one, and you do not need to: both are rows to match,
  and `uuid` identifies each of them either way.

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
  (comparison_id, friend_name_en, friend_name_th, person_name_en, person_name_th,
   batch_number, status, upload_name, company_name, extra)
VALUES
  (:comparison_id,      -- from X-Comparison-ID / the CSV column
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

One column name worth checking against your `INSERT`, since it does not match the CSV you were
handed: `extra` (`jsonb`) is there for any non-standard fields you want to keep — it is unchanged,
and NULL is a perfectly good value for it. The Facebook side of the pair used to be a third
mismatch, `friend_name` against the CSV's `fb_name`; it is now the two `friend_name_*` columns
below and there is no single-name column left to confuse.

**Two optional columns, added 2026-07-28. Both nullable; an `INSERT` that omits them is still
valid** — this is an appended ask, not a new requirement.

| Column | Write it with | Why it helps |
|---|---|---|
| `friend_id` | the CSV's `uuid` — it **is** `friend.id` | Exactness |
| `company_contact_id` | the matched contact's `company_contact.id` | Exactness |

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
- **It does not keep an import you never received.** The import forwards its rows inside the
  import request. If you reject the file or do not answer within 30 s, the whole import is unwound
  before the request returns — its rows are deleted, the run it opened is deleted, and it leaves no
  entry on the Uploads page. The caller gets a `502`, and it means *nothing was imported*.

  This is the one place where "loudly" was not enough. The rows were already in the cumulative
  tables by the time you were asked, so an import marked `failed` and left in place put friends and
  contacts into every later dedup, roster and count while permanently awaiting a verdict from a
  workflow that was never handed anything to decide.

  Two consequences worth knowing:
    - There is no failed import to retry. `POST /api/comparisons/:id/send-webhook` still exists and
      still re-sends an import's stored rows on demand, but reaching a failed send now means
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
