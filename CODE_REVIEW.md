# Network Intel — Code Review

Full static audit of the API, frontend, and `sqldb` extension. Findings are grouped **High / Medium / Low**. Line references use `path:line`.

> Reviewed statically — the app was not run, so runtime claims (e.g. H5 boolean binding, H1 404) are inferred from reading the code, not observed failures.

---

## 🔴 HIGH — broken functionality, data loss, security

### API

**H1. Webhook callback endpoint doesn't exist — comparison results can never come back**
`api/src/controllers/compare.controller.ts:82` tells the external service to POST results to `…/api/comparisons/:id/webhook-results`, but no such route is registered. The real handler is `POST /api/callbacks/comparison-results` (`api/src/routes/callbacks.route.ts:7`). The external workflow hits a 404 → results are never stored, the session never moves to `completed`.

**H2. Comparison results are write-only — never readable**
`ComparisonResultsModel.findBySessionId` (`api/src/models/comparison-results.model.ts:43`) is defined but called by nothing. No controller/route exposes `comparison_results`. The match scores (the entire point of the app) are stored but no endpoint returns them to the UI.

**H3. Live secrets committed to the repo**
`.gitignore` does not exclude `.env`, and `api/.env` contains a `JWT_SECRET` and three live webhook URLs with embedded tokens. Rotate these and remove the file from version control.

**H4. Global UNIQUE index breaks uploads / "merge"**
Migration `api/migrations/0006_create_upload_history_and_merge_support.ts:42-47` puts a UNIQUE index on `facebook_data(fb_name, upload_person_name)` with **no `session_id`**, and the inserts are plain `insertInto(...).values(...)` with **no `ON CONFLICT`** (`api/src/models/facebook-data.model.ts:23`). Duplicate friend names within one file, or re-uploading with the same `upload_person_name`, throws a UNIQUE violation and fails the whole upload (session → `failed`). The "merge support" the migration name promises is never implemented (no upsert).

**H5. SQLite cannot bind the `is_complete` boolean**
`ComparisonResultsModel.createMany` inserts `is_complete` as a JS boolean (`api/src/models/comparison-results.model.ts:36`). The active env is SQLite (`ENVIRONMENT=TEST` → `better-sqlite3`), which throws `can only bind numbers, strings, bigints, buffers, and null` on booleans. This insert fails at runtime (currently masked because H1 means the callback never fires). Convert to `0/1`.

### Frontend

**H6. `process` page reads stale state in the WebSocket handler**
`frontend/app/process/page.tsx:237-289` — `handleWebSocketMessage` closes over `progress`, but `connectWebSocket` (a `useCallback`) doesn't list it as a dep (`:162`). The socket captured at connect time always reads the initial `progress`, so accumulation and final counts are wrong.

**H7. `facebook` page tears down the socket on the first state change**
`frontend/app/facebook/page.tsx:78-87` only opens the socket while `workflowStep === 'saving'`. The first `saved_to_database` message flips the step, the effect cleanup closes the socket, so the later `comparison_*` progress messages can never arrive — the real-time comparison UI is dead.

**H8. Unchecked `response.json()` on backend errors**
Across the data pages (e.g. `frontend/app/results/page.tsx:73-95`, `frontend/app/facebook/page.tsx:157`), responses are parsed without checking `response.ok`. A 500 returning HTML makes `.json()` reject, and counts like `result.data.companyRecordsCount.toLocaleString()` (`frontend/app/facebook/components/FacebookComparison.tsx:80`) crash if the field is missing.

### sqldb extension

**H9. `getPool()` sets the singleton before migrating + is racy + unawaited at import**
`extensions/sqldb/src/base.model.ts:26-40` assigns `DBModel.pool` *before* `await migrate()`; if migration throws, the next call sees a non-null pool and returns an unmigrated DB. The null-check/await gap also lets concurrent callers create duplicate pools, and the top-level `DBModel.getPool()` (`:48`) is fired unawaited/uncaught → unhandled rejection on failure.

**H10. Pools are never closed**
`extensions/sqldb/src/pools/postgres.ts` / `sqlite-file.ts` memoize a Kysely instance but expose no teardown; the `ConnectionPool` interface (`extensions/sqldb/src/pools/pool.ts:5`) has no `close()`. Resetting `DBModel.pool = null` leaks the underlying `pg.Pool`/sqlite handle.

---

## 🟡 MEDIUM — incorrect edge cases, leaks, missing handling

### API

- **Premature "complete".** `updateBatchStatus` ignores the `totalBatches`/`isComplete` args (`api/src/models/comparison-results.model.ts:53`); `getBatchStatus` derives `total_batches = max(maxBatchNumber, received)` (`:84`), so `received >= total` is true as soon as the highest-numbered batch arrives → session marked `completed` early.
- **Double-counted total.** `total_records` is counted *after* the insert, then `payload.results.length` is added again (`api/src/controllers/callbacks.controller.ts:104`).
- **In-memory batch tracker.** `batchTracker` (`api/src/models/comparison-results.model.ts:22`) is lost on restart, breaks under multiple instances, and is never cleared (`clearBatchTracking` is unused → unbounded growth).
- **Pagination without `ORDER BY`.** `api/src/models/company-data.model.ts:43-50` and `api/src/models/facebook-data.model.ts:42-49` page with `LIMIT/OFFSET` and no stable order → rows can repeat or be skipped between pages.
- **`company_data` UNIQUE index is a no-op.** Its key includes `person_name_en`, which the parser always sets to `null` (`api/src/services/file-parser.service.ts:68`); SQLite treats NULLs as distinct so it enforces nothing — the opposite of H4, but equally wrong.
- **WebSocket killed after 2 min.** `connectionTimeout` (`api/src/services/websocket.service.ts:84`) is set once and never reset on activity/pong, so every connection is force-closed at 120s even mid-comparison.
- **`facebook_file_path` stored then deleted.** Saved on the session (`api/src/controllers/comparisons.controller.ts:108`) but the file is `unlinkSync`-ed immediately after (`:148`) and never read — dangling path.
- **Merge/continue never merges.** `parent_session_id` is stored (`api/src/controllers/comparisons.controller.ts:253`) but no query ever combines parent + child data, so "continue from existing" doesn't actually carry anything forward.
- **`triggerComparison` fakes success when unconfigured.** With `COMPARE_WEBHOOK_URL` unset it still returns success and sets status `processing` (`api/src/controllers/compare.controller.ts:127`) — the session is then stuck forever.
- **Blocking sync I/O.** `fs.readFileSync`/`JSON.parse`/`unlinkSync` on files up to the 500 MB multer limit (`api/src/services/file-parser.service.ts:38/81`) block the event loop.
- **Over-broad logging.** `api/src/middlewares/logging.middleware.ts:52-61` serializes full request *and* response bodies (PII + large payloads) on every request.
- **CORS `*`.** `api/src/middlewares/cors.middleware.ts:4` allows all origins while the configured `CORS_ORIGIN` env is ignored.
- **Malformed callback base.** `WEBHOOK_CALLBACK_URL_BASE` in `api/.env` is a token string, not a URL — even if H1's route existed, the callback URL would be malformed.

### Frontend

- **No unmount/abort guards** on any fetch effect (e.g. `frontend/app/results-merged/page.tsx:53-80`) → setState-after-unmount on navigation.
- **`facebook` socket has no reconnect/fallback** (unlike `process`), and `sessionIdRef` is written but never read (`frontend/app/facebook/page.tsx:89-115`).
- **`ConfidenceChart`** uses `Math.max(...data, 100)` (`frontend/app/components/ConfidenceChart.tsx:10`) — stack-overflow risk on large arrays, and the forced floor of 100 flattens real bars.
- **Delete buttons don't disable during async delete** (`frontend/app/components/DeleteConfirmModal.tsx:39`); `session-detail` even tracks `isDeleting` but never passes it → double-submit.
- **`Button`** spreads `{...props}` after `disabled=` (`frontend/app/components/Button.tsx:62`), so a caller `disabled={false}` overrides the loading guard.
- **`history` page hides the whole grid** via `display:none` when the modal opens (`frontend/app/history/page.tsx:200`).
- **"Download CSV" button has no `onClick`** (`frontend/app/results/page.tsx:161`); the merged page renders an Alert dismiss that's a no-op (`frontend/app/results-merged/page.tsx:198`).
- **`Navbar`** calls `.startsWith` on a possibly-null `usePathname()` (`frontend/app/components/Navbar.tsx:11`).

### sqldb extension

- **`DB = any`** (`extensions/sqldb/src/db.types.ts:2`, `extensions/sqldb/src/pools/pool.ts:3`) defeats Kysely's type safety everywhere.
- **In-memory SQLite is the default env** (`extensions/sqldb/src/base.model.ts:32`) → dev data vanishes each restart, and dev/test/prod each run a different engine.
- **Extension's own `migration.test.ts` can't pass** — it asserts a `demos` table but the extension ships no migrations folder. (The *API* migrations live in `code/api/migrations` and do run, since the server's cwd is `api/`.)
- **`sqlite-file.ts` default path** `'../database.sqlite'` resolves *above* cwd (`extensions/sqldb/src/pools/sqlite-file.ts:7`).

---

## 🟢 LOW — dead code, duplication, hygiene

### API
- **`SessionModel` + `Sessions` type reference the dropped `sessions` table** (migration `0005`) — pure dead code (`api/src/models/session.model.ts`, `api/src/db.types.ts:9`).
- **Dead Thai-title parsing** in `api/src/services/file-parser.service.ts:54-62`: `title`/`personNameTh` are computed then ignored; `person_name_th` stores the full untrimmed name. Also uses `record: any`.
- **Unused `import type { DB }`** in `api/src/models/upload-session.model.ts:2`, `history-session.model.ts:2`, `session.model.ts:2`.
- **`PaginatedResult` interface duplicated** in 3 model files; identical try/catch-500 blocks duplicated across every controller (extract an `asyncHandler`).
- **`DEFAULT_USER_ID` hardcoded** → the ownership checks in `history.controller` are effectively no-ops.
- **`.gitignore` excludes `package-lock.json`** — the lockfile should be committed for reproducible builds.

### Frontend
- **Dead components** never imported by a page: `StoredDataTable`, `FilePreviewTable`, `SessionSelectorModal`, `SelectedSessionBanner`, `ToggleButtonGroup`; dead utils `parseCompanyCSVPreview`, `parseFacebookJSONPreview`, `readFileAsText`, `fetchFacebookData`.
- **Six redirect-only stub pages** (`upload-continue`, `upload-selected`, `process-merge`, `delete-confirm`, `save-modal`, `history-empty`) — replace with `next.config` redirects.
- **~90% duplication** across `results-merged` / `results-saved` / `session-detail` (same interface, fetch, memos, CSV, JSX); `CompanyUploadHistory` ≈ `FacebookUploadHistory`; `validateFile`/`formatFileSize` duplicated between the two upload pages.
- **`API_BASE_URL`/`WS_BASE_URL` redefined in ~10 files** — centralize.
- **`ResultsTable` uses array index as key** (`frontend/app/components/ResultsTable.tsx:103`) → wrong reconciliation under filter+paginate.
- **Wrong copy:** `FacebookUploadHistory` says "Facebook CSV file" but Facebook uploads are JSON (`frontend/app/facebook/components/FacebookUploadHistory.tsx:35`).
- **`FileCard` redundant ternary** — both branches return `'border-red-400'` (`frontend/app/components/FileCard.tsx:23`).
- **Three different confidence-color thresholds** across `SessionCard`, `SessionSelectorModal`, `ConfidenceBadge`.
- **Deprecated `images.domains`** in `frontend/next.config.ts` (unused).

### sqldb extension
- `sqlite-file.ts` ≈ `sqlite-mem.ts` (differ by one arg); `connect()` is misnamed (returns a cached singleton, not a per-call connection); ESLint disables `no-explicit-any` globally; toolchain pinned to very old versions.

---

## Top 6 to fix first
1. **H1** callback route mismatch + **H2** no read endpoint → results never reach the UI (the core feature is non-functional end-to-end).
2. **H4/H5** the `facebook_data` UNIQUE index and boolean binding → uploads and result-storage throw on SQLite.
3. **H3** rotate and un-commit the secrets in `api/.env`.
4. **H6/H7** the WebSocket stale-closure + premature teardown on `process`/`facebook`.
5. **M (batch logic)** premature completion + double-counted totals + volatile in-memory tracker.
6. **Pagination `ORDER BY`** + the dead `SessionModel`/dead components cleanup.
