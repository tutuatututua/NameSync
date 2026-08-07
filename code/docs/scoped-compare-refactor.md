# Refactor: fix upload compares to English full name; add scoped re-compares from the Network page

> Task spec drafted 2026-08-05. Implement all four parts: the upload-page simplification, the Network-page scoped compares, the webhook contract change, and the dead-code cleanup. Do not start work outside this scope.

> **Superseded in part, 2026-08-06.** Two entry points this spec describes as existing are gone: the
> Network header's "Find connections" button (with the "Whose friends" roster picker beside it —
> both replaced by the single query bar in `OverviewTab`/`NetworkQuery`), and the Compare button on
> the Uploads table's "Runs" column. Runs are now started from a company page, an owner page, or a
> past run under **Network → Results**. The scoped-compare mechanics below (`filter_by` /
> `filter_value` on the webhook, `RequestedScope`) are unaffected and still current — only the
> buttons that reach them moved.

## Background (verified codebase facts — trust these)

- Upload page = `/uploads` → `code/frontend/app/(app)/uploads/page.tsx` → `components/upload/ImportReview.tsx`, which renders the compare picker `CompareModeControl` (`components/compare-mode.tsx`). Compare values come from `code/extensions/contract/src/compare-by.ts`: `COMPARE_TYPES = ['full','name','surname']`, `COMPARE_LANGUAGES = ['en','th']`, combined as `'en_full'` etc.; `DEFAULT_COMPARE_BY = 'en_full'`.
- "Relation page" = the **Network** page at `/` (`app/(app)/page.tsx`), tabs: `company` ("Company"), `uploaders` ("Relationship owners"), `search`. It already has a "Find connections" button → `NewComparisonDialog` → `POST /api/comparisons/compare` with `{company_names, compare_by, sources}`.
- Runs are stored in the `comparison` table (`selected_companies text[]`, `sources text[]`, `compare_by text`, `status`, `created_by`). History already exists: `GET /api/comparisons` → `ComparisonModel.listWithStats` (live-aggregated `rowCount` / `matchCount` / `scoredCount`) → rendered by `components/network/RecentRuns.tsx` ("Recent comparisons").
- People fields: `upload.uploaded_by` = who performed the import; `friend.relationship_owner` = whose relationship each row is (wire name `uploadPersonName`). There is **no** `upload_user` column.
- Import dedup today is advisory: `ImportPrecheckService` returns `verdict ∈ {new, partial, repeat, redundant}`; only `redundant` blocks (`precheckBlocks` in contract `uploads.ts`), and `force='true'` overrides. Rows always stack via `FriendModel.mergeUpload` + `person_key`.
- Prod runs with `EXTERNAL_MATCHER=1`: an import IS a run — `POST /api/comparisons/run` opens a `comparison`, forwards rows to the webhook, and the external workflow (which shares the Postgres database) writes `comparison_result` directly (no callback; progress is polled). The CSV contract (`code/api/docs/EXTERNAL-MATCHER.md`) includes `compare_type`, `compare_language`, `compare_by`, `compare_sources`.

## Webhook contract change (applies to Parts 1 and 2)

Every run sent to the external matcher webhook gains two new metadata keys:

- `filter_by` — how the workflow should select rows: `'company' | 'owner' | 'file' | 'upload'` (`'upload'` = a normal import-driven run, today's behavior).
- `filter_value` — the scope variable: the company name for `company`, the `relationship_owner` for `owner`, the `upload.id` for `file`, and the upload/session id for `upload`.

The workflow uses these two keys to select which rows to read from the `friend` and `company_contact` tables in the shared database. Normal imports keep forwarding their CSV rows exactly as today, just with `filter_by='upload'` + `filter_value` added; for the new scoped re-compares (Part 2), the workflow selects existing rows itself from these keys — inspect the current webhook payload builder (`forwardRowsToWebhook` in `comparisons.route.ts`, `services/webhook.service.ts`) and keep the payload shape otherwise identical. Document both keys in `docs/EXTERNAL-MATCHER.md`.

## Part 1 — Uploads: English full name only, hard duplicate block

1. Remove the compare-mode UI from the upload flow: drop `CompareModeControl` (and the "How to compare" box) from `ImportReview.tsx`. Keep the component itself — `NewComparisonDialog` still uses it.
2. Frontend sends no `compareBy` on `POST /api/upload-sessions/preview` and `POST /api/comparisons/run`; backend forces `compare_by = 'en_full'` for import-driven runs. Remove `compareBy` from `ImportFieldsSchema` in `code/extensions/contract/src/comparisons.ts` (reject or ignore if sent). Keep emitting `compare_type=full`, `compare_language=en`, `compare_by=en_full` in the external-matcher CSV so the workflow contract is unchanged, and add `filter_by='upload'` + `filter_value` per the contract change above; update `docs/EXTERNAL-MATCHER.md` to say compare mode is now constant for imports.
3. Simplify the language-gate logic in ImportReview (`noNamesForMode`) to the single remaining case: refuse when the file has no English names to score.
4. Tighten the duplicate rule: re-importing the same data is **refused** unless `uploaded_by` differs OR `relationship_owner` differs from the prior import. Implement in `ImportPrecheckService` (it already computes known rows via `countKnown` / `spellKey`): when every importable row is already on file for the same owner AND a prior non-rolled-back upload with the same `uploaded_by` covers them, the verdict blocks. Update `precheckBlocks`, the precheck UI copy in ImportReview, and the server-side refusal in `POST /comparisons/run` (server must enforce, not just the client).
5. `force='true'` remains as the explicit escape hatch for the block (keep current semantics).

## Part 2 — Network page: run scoped compares from Company / Owner / File

Add "run a compare" entry points on three groupings, each opening a dialog (reuse `NewComparisonDialog` / `CompareModeControl`) where the user picks type (`full`/`name`/`surname`) and language (`en`/`th`):

1. **Company** — from a company row in `ConnectedCompanies` (Company tab) and from `/companies/[name]`: run with `filter_by='company'`, `filter_value=<company name>`. Prefill from the clicked row (e.g. BlueBrick).
2. **Owner** — from a row in the Relationship owners tab and from `/uploaders/[name]`: `filter_by='owner'`, `filter_value=<relationship_owner>` — compare only that owner's friends.
3. **File** — from an import row on the Uploads page (a specific `upload.id`): `filter_by='file'`, `filter_value=<upload.id>` — compare only rows from that import.

Implementation notes:

- Persist the scope on the `comparison` table: add `filter_by text` and `filter_value text` columns (keep `selected_companies`/`sources` working for existing rows; a legacy/company run may populate both). Keep `findDuplicates` matching correctly with the new columns. **Write the DDL as a migration .sql file in `code/api/docs/` following the existing `add-comparison-created-by.sql` pattern — do NOT apply it to the running compose database (it is live prod).** Also reflect the new columns in `code/api/docs/schema-redesign.sql` (the canonical schema doc) and in `db.types.ts`.
- Extend `POST /api/comparisons/compare` (contract `CompareByCompanyBodySchema` in `uploads.ts`) to accept `filter_by`/`filter_value`. With `EXTERNAL_MATCHER=1`, scoped runs open a `comparison` and call the webhook with the two new keys (workflow selects the rows); with the flag off, the internal `MatcherService` applies the equivalent row filter itself so dev/tests still work end to end.
- History: every scoped run is a `comparison` row and must show up in "Recent comparisons" with its scope, compare mode, match count, and number compared. Extend `ComparisonListItemSchema` (contract `compare.ts`), `listWithStats`, and `RecentRuns` badges (add scope badges — company/owner/file — next to the existing `CompareModeBadge`/`SourcesBadge`).

## Part 3 — Cleanup: delete all code the refactor orphans

Removing the per-import compare choice makes real code dead. Delete it — no commented-out blocks, no `@deprecated` stubs, no unused exports left behind. Known candidates (verify each before deleting; some are shared with `NewComparisonDialog`, which stays):

- `ImportReview.tsx`: the `compareBy` state, the "How to compare" box, all `th`/mode branches of `noNamesForMode`, and any now-unused imports from `compare-mode.tsx` / `compare-by.ts`.
- Contract `ImportFieldsSchema`: the `compareBy` field, plus any preview fields that no longer have a consumer once the language gate is en-only (check every consumer of `scorableRows.th` before touching it — the preview display may still use it).
- `comparisons.route.ts`: the `compareBy ?? DEFAULT_COMPARE_BY` handling on the import path and the old two-language gate; replace with the fixed `en_full` + English-scorable check.
- `ImportPrecheckService` / `precheckBlocks`: branches and UI copy for the old advisory-only semantics that the new hard block supersedes.
- Tests that exist only to cover per-import compare selection (parts of `owner-and-compare-by.test.ts`, precheck advisory cases) — rewrite them to cover the new rules instead of keeping both.
- `EXTERNAL-MATCHER.md` sections describing per-import compare selection.

Then do a final sweep: typecheck all three packages (`@extensions/contract`, `code/api`, `code/frontend`) and grep for each symbol you removed to confirm zero remaining references. If an export in `compare-by.ts` ends up with no consumers at all, delete it too.

## Quality bar (best practices for this codebase)

- **Contract-first**: every wire-shape change starts in `@extensions/contract` zod schemas; API and frontend derive types from there. No duplicated string literals for `filter_by` values — export one const array + type the way `COMPARE_BY_VALUES` does.
- **Server enforces, client mirrors**: the duplicate block and the `en_full` force live in the API; the frontend checks exist only for UX. Anything sendable via curl must be validated server-side.
- **Migrations are additive and idempotent** (`ADD COLUMN IF NOT EXISTS`), written as files, never executed against the compose DB.
- **Reuse existing patterns**: TanStack Query hooks in `hooks/mutations.ts` with proper invalidation of the `useComparisons` query key; badges/`StatTile`/dialog components from `components/network`; `rowVerdictSql`/`StatusCounts` for any new counting — do not invent a parallel stats path.
- **Respect the naming drift as-is**: internal `uploaders` spelling vs. the visible "Relationship owners" label is deliberate; don't rename routes or tab values.
- **Leave unrelated code alone**: the working tree carries a large body of uncommitted work. Never `git stash`, never reformat or revert files outside this spec's scope.

## Constraints

- Shared types live in `@extensions/contract` — change schemas there first, then API, then frontend.
- Never run DDL or writes against the compose DB (live prod with real users). Migration files only; read-only inspection via `docker exec node -e` if needed.
- API tests: vitest against a hand-started Postgres on :55432, run with `--no-file-parallelism`. Update affected suites (`flow`, `external-matcher`, `owner-and-compare-by`, `unit`, precheck-related) and add coverage for: the new duplicate block (same data + same uploader + same owner → refused; either differing → allowed; force bypass), forced `en_full` on imports, `filter_by`/`filter_value` present and correct in the webhook payload for all four scope kinds, and owner-/file-scoped runs incl. history stats.
- Frontend has no hot reload on :3000 — `docker compose build frontend && docker compose up -d --no-deps frontend` before any browser verification.

## Acceptance criteria

1. `/uploads` shows no compare-mode picker; every import runs as `en_full`; sending another `compareBy` to the API does not change that.
2. Re-importing an identical file with the same uploader and same relationship owner is refused with a clear message; changing either one proceeds; `force` still overrides.
3. From a company, a relationship owner, and an uploaded file, I can launch a compare choosing type × language.
4. Every webhook call carries `filter_by` + `filter_value` (`upload` for normal imports; `company`/`owner`/`file` for scoped runs) so the workflow can select rows from `friend` / `company_contact`.
5. Each scoped run appears in "Recent comparisons" with its scope, mode, match count, and compared count.
6. No dead code remains from the removed feature: typecheck passes in all three packages and removed symbols have zero references.
7. Full API test suite passes.

## Open items for the human

- Confirm the key names `filter_by` / `filter_value` and the value spelling (`company`/`owner`/`file`/`upload`) with the n8n workflow side — the workflow must be updated to read them before scoped runs work in prod.
- "File" scope is modeled as a specific import (`upload.id`), not a source type (facebook/linkedin). Flip if that's wrong.
- `force=true` still bypasses the duplicate block. Remove Part 1 item 5 for an absolute block.
