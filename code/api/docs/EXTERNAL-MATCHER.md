# The external matcher workflow

How NameSync hands an import to the workflow, and what the workflow must do with it.

This is a **contract between two systems that share one database**. NameSync does not receive
the results over HTTP — it reads them out of Postgres, by polling. So every promise below is
about a table, not an endpoint.

---

## Turning it on

Nothing in this document takes effect until **`EXTERNAL_MATCHER=1`** is set on the API.

With the flag off (the default), NameSync behaves exactly as it always has: pressing
**Compare** scores the names itself, in Postgres, and returns the run immediately. That path
is untouched and still works — the flag chooses which matcher runs, and both remain.

Before turning it on, apply [`migrations/2026-07-14-row-status.sql`](migrations/2026-07-14-row-status.sql)
by hand. It adds the `status` column the workflow writes to. The app cannot add it itself
(`DB_SKIP_MIGRATE=1`), by design.

---

## The flow

```
user imports a file
        │
        ▼
NameSync  ─── writes rows to friend / company_contact, each status='processing'
          ─── creates one `comparison` row (status='processing')  ← this is the run
          ─── POSTs the rows to the webhook, carrying the comparison id
        │
        ▼
workflow  ─── matches each row against the opposite table
          ─── writes comparison_result rows  (the pair + the score)
          ─── stamps each source row  status = 'match' | 'unmatch'
        │
        ▼
NameSync  ─── polls: "does this upload still have rows at 'processing'?"
          ─── when none do: upload → 'completed', comparison → 'completed'
          ─── the user, who has been watching the Compare page, sees the results
```

A **Facebook** import is matched against every contact in `company_contact`.
A **company** import is matched against every friend in `friend`.
(Which is why an import can start a run on its own — the other side is already on file.)

---

## 1. What NameSync sends

`POST` to `FACEBOOK_WEBHOOK_URL` (social imports) or `COMPANY_WEBHOOK_URL` (company imports),
as `multipart/form-data` with a single `file` part — a CSV, exactly as today.

**Headers**

| Header | Meaning |
|---|---|
| `X-Session-ID` | The **upload** id. Which import this is. |
| `X-Comparison-ID` | The **run** id. **Write `comparison_result.comparison_id` with this.** |

`X-Comparison-ID` is the new one, and it is the important one: it is the only way the results
you write can be attached to the run the user is watching.

**CSV columns — company import**

```
uuid,company_name,person_name_th,person_name_en,status,session_id,comparison_id
```

**CSV columns — social import**

```
uuid,fb_name,timestamp,upload_person_name,status,session_id,comparison_id
```

`uuid` is the row's primary key — `company_contact.id` or `friend.id`. It is what you write
back against. `status` will read `processing` on every row, because that is what it is.

The `comparison_id` column carries the same value as the `X-Comparison-ID` header. It is
duplicated into every row on purpose: a row-wise tool (n8n and friends) can reach a CSV cell
far more easily than a request header.

### The request, in full

Captured off the wire, not written from memory. This is the whole of what arrives — a company
import of two contacts, one of whom has a comma in their employer and a double-quote in their
name, so the quoting rules are visible rather than described:

```http
POST /company HTTP/1.1
host: wf.promptxai.com
x-session-id: 22
x-comparison-id: 12
content-type: multipart/form-data; boundary=----formdata-undici-056721390935
content-length: 418

------formdata-undici-056721390935
Content-Disposition: form-data; name="file"; filename="company-22.csv"
Content-Type: text/csv

uuid,company_name,person_name_th,person_name_en,status,session_id,comparison_id
325,"Wire Demo, Inc.",ปรีชา วงศ์,Preecha Wong,processing,22,12
326,"Wire Demo, Inc.","สุดา ""Su"" ใจดี",Suda Jaidee,processing,22,12
------formdata-undici-056721390935--
```

And a social import of two friends:

```http
POST /facebook HTTP/1.1
host: wf.promptxai.com
x-session-id: 23
x-comparison-id: 13
content-type: multipart/form-data; boundary=----formdata-undici-012377751986
content-length: 388

------formdata-undici-012377751986
Content-Disposition: form-data; name="file"; filename="facebook-23.csv"
Content-Type: text/csv

uuid,fb_name,timestamp,upload_person_name,status,session_id,comparison_id
1320,Preecha Wong,2025-02-19T21:20:00.000Z,Nadhee,processing,23,13
1321,"Suda ""Su"" Jaidee",2025-02-19T22:20:00.000Z,Nadhee,processing,23,13
------formdata-undici-012377751986--
```

Things worth reading twice:

- **It is a file part, not a request body.** One part, named `file`, `text/csv`, with a `.csv`
  filename. Read it the way you would read an uploaded attachment. A raw `text/csv` body is what
  this *used* to send, and Fastify answered every one of them with `415`.
- **The boundary is generated per request.** Never hard-code it — parse the `content-type`.
- **Quoting is RFC 4180.** A field is quoted only if it holds a comma, a double-quote or a
  newline; an embedded double-quote is doubled (`""`). `"Wire Demo, Inc."` and
  `"สุดา ""Su"" ใจดี"` above are both real output, not illustrations. A naive `split(",")` tears
  those rows in half — use a CSV parser.
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

| Value | Means |
|---|---|
| `match` | This row was matched to someone. |
| `unmatch` | This row was finished, and matched nobody. |

**A row must never be left at `processing`.** That is the single hard requirement here.
NameSync decides an import is finished by asking whether any of its rows are still
`processing` — so one row left behind means the import never completes, the Compare page
spins forever, and the user is told a job is running that is not.

There is no CHECK constraint on the column: an unexpected value will be stored, and NameSync
will read it as "finished, not a match" rather than rejecting your write. Only `processing`
is special.

### b. The result, if it matched

```sql
INSERT INTO lakeshore.comparison_result
  (comparison_id, fb_name, person_name_en, person_name_th,
   matching_score, batch_number, is_complete, upload_name, extra)
VALUES
  (:comparison_id,      -- from X-Comparison-ID / the CSV column
   :friend_name,        -- the Facebook side of the pair
   :person_name_en,     -- the company side
   :person_name_th,
   :score,              -- 0.0 – 1.0
   1, true,
   :uploaded_by,        -- who imported the friend, when known
   NULL);
```

`comparison_result` is the evidence behind the run: the pair, and how close it was. It is what
the results table renders and what the app counts matches from.

**Writing a row only for matches is supported, and is the minimum.** NameSync will still be
correct: it takes the denominator ("5 of 12 matched") from the import's own rows, not from this
table, so a run that only stores its winners cannot report a 100% hit rate.

**Writing a row for _every_ name — matched or not, with its closest counterpart and score — is
better**, and is what the internal matcher does. It costs you nothing extra (you computed the
closest name already, to decide) and it buys the user the one question the matches alone can
never answer: *why didn't this person match?* With every row stored, the results table offers
an **All scored** view of the near-misses; with only matches, that view does not exist and the
table says so.

**`matching_score` is a similarity, 0–1, not a percentage.** `0.87`, never `87`.

NameSync draws the line between "a match" and "a coincidence" at **`matching_score >= 0.6`**
(`MATCH_THRESHOLD`, in `extensions/contract/src/compare.ts`). Keep `status = 'match'` and a
score `>= 0.6` in agreement: a row stamped `match` whose score is `0.3` will be counted one
way by the Uploads page and the other way by the results table, and the app will contradict
itself on screen.

---

## 3. What NameSync does not do

- **It does not call you back.** There is no callback for this path. (The existing
  `POST /api/callbacks/comparison-results` endpoint is for the *other*, HTTP-push matcher and
  is unrelated — leave it alone.)
- **It does not retry.** If the workflow dies halfway, its rows stay at `processing` and the
  import stays unfinished, visibly, until someone intervenes. That is the intended failure
  mode: a stuck import is a fact, and hiding it behind a timeout would turn a visible problem
  into a silent wrong answer.
- **It does not clean your names for you.** It already did, at import: `friend_name_clean` and
  `person_name_*_clean` hold the name with titles, suffixes and nicknames stripped. Match on
  the `_clean` columns; they are what the internal matcher uses.
