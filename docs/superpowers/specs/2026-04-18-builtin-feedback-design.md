# Built-in Feedback System — Design Spec

**Status:** Proposed (v1.2+)
**Date:** 2026-04-18
**Owner:** TBD
**Tracking:** GitHub issue #73 (point 6)
**Effort:** M

## 1. Problem Statement

The current bug-report flow (`src/app/bugreport/page.tsx` + `src/app/api/bugreport/route.ts`) is gated on a GitHub token and repository configured by an admin. The status route returns `configured: false` when those are missing, and the UI degrades to an "ask your admin to configure GitHub" screen — so a non-technical owner of a self-hosted HealthLog instance cannot collect feedback at all without first procuring a GitHub PAT and dedicating a repo.

Verbatim from issue #73, point 6: *"Provide a simple built-in feedback system where users can submit reports without GitHub accounts, repositories, or tokens. The app should handle issue creation automatically in the background. Alternatively, provide a pre-configured default repository maintained by the developer."*

We need a feedback path that **works with zero external configuration**, while keeping the existing GitHub integration available as an **optional escalation** for instance owners who do want public issues.

## 2. Approach

- **Primary store: Postgres.** Every submission lands in a new `Feedback` table managed by Prisma. No external dependency required.
- **Admin inbox UI** at `/admin#feedback` lists, filters and triages submissions.
- **GitHub stays optional and per-item.** The admin can press "Publish to GitHub issue" on any feedback row; the existing route logic in `src/app/api/bugreport/route.ts` is refactored into a reusable helper and called from the new admin endpoint. If GitHub isn't configured, the button is hidden — the rest of the flow is unaffected.
- **v1 admin notification: email** via the existing `src/lib/notifications/dispatcher.ts` (Telegram / ntfy / web-push reuse the same dispatcher). Optional; silent if no admin channel is configured.
- **Existing `/api/bugreport` is deprecated but kept** for two release cycles so any external automation still works. Internally it forwards to the new feedback pipeline.

## 3. Data Model

New Prisma model in `prisma/schema.prisma`, additive only:

```prisma
enum FeedbackCategory { BUG FEATURE_REQUEST QUESTION OTHER }
enum FeedbackStatus   { OPEN ACK RESOLVED ARCHIVED }

model Feedback {
  id                String           @id @default(cuid())
  userId            String?          // nullable — see auth note below
  user              User?            @relation(fields: [userId], references: [id], onDelete: SetNull)
  email             String?          // snapshot of submitter email at time of submission
  category          FeedbackCategory @default(BUG)
  subject           String           @db.VarChar(200)
  description       String           @db.Text  // ≤ 5000 chars enforced in Zod
  screenshotBase64  String?          @db.Text  // ≤ 5 MB; later moved to object storage
  metadata          Json?            // { url, userAgent, locale, appVersion, viewport, timestamp }
  status            FeedbackStatus   @default(OPEN)
  adminNote         String?          @db.Text
  gitHubIssueUrl    String?
  notifiedEmail     Boolean          @default(false)
  createdAt         DateTime         @default(now())
  updatedAt         DateTime         @updatedAt

  @@index([status, createdAt])
  @@index([userId])
}
```

Notes:
- `userId` is nullable to keep the door open for anonymous public-instance submissions in a later iteration; **v1 still requires auth** (`requireAuth()`), so the column will always be populated. The `email` snapshot survives user deletion for triage continuity.
- `metadata` is a free-form JSON envelope mirroring the same context we'd otherwise paste into a GitHub issue body — we capture it once at submission time so the admin doesn't have to ask "what page were you on?".
- An `AuditLog` row (`feedback.submit`, `feedback.status_change`, `feedback.publish_github`) follows the existing pattern in `src/lib/auth/audit.ts`.

## 4. API

All routes use `apiHandler` (Wide Events + x-request-id) and return the standard `{ data, error, meta }` envelope.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/api/feedback` | user | Submit feedback. Rate-limited 5/h per `user.id`. Zod-validated. Returns `{ id, confirmationNumber }`. |
| `GET`  | `/api/admin/feedback` | admin | Paginated list. Query params: `status`, `category`, `q`, `page`, `pageSize` (default 20, cap 100). |
| `GET`  | `/api/admin/feedback/:id` | admin | Single item with raw `metadata` and screenshot. |
| `PATCH`| `/api/admin/feedback/:id` | admin | Mutate `status` and/or `adminNote`. Writes audit log. |
| `POST` | `/api/admin/feedback/:id/github` | admin | Publish to GitHub. 404 if GitHub not configured. Stores `gitHubIssueUrl` on success. |
| `GET`  | `/api/feedback/status` | user | Public capability probe: `{ available: true, githubAvailable: boolean }`. Replaces `/api/bugreport/status`'s "configured: false" wall. |

`apiSuccess` payloads use `confirmationNumber = id.slice(-6).toUpperCase()` so users can quote a short code without leaking the full cuid.

## 5. UI

### `/bugreport` (renamed conceptually to "Feedback", URL kept)
- **Category** dropdown (Bug / Feature request / Question / Other).
- **Subject** input (max 120 chars, required).
- **Description** textarea (10–5000 chars, existing constraint).
- **Screenshot** optional, same upload control as today, ≤ 5 MB, EXIF stripped client-side before base64 encoding.
- **Submit** — always enabled when authenticated. No more "not configured" wall.
- On success: toast "Thanks for your feedback — reference #ABC123".

### Admin section `/admin#feedback`
- Table: created, category badge, subject, status badge, submitter, actions.
- Filters: status (OPEN/ACK/RESOLVED/ARCHIVED), category, free-text search over `subject`/`description`.
- Detail dialog: full description, screenshot preview, raw `metadata` JSON, admin note textarea, action buttons **Ack** / **Resolve** / **Archive** / **Publish to GitHub** (last one only when `githubAvailable`).
- Empty states (no feedback yet, no results for filter) with translated copy.

## 6. Screenshot Handling

- **Storage:** base64 in the `screenshotBase64` column. Hard cap **5 MB per item** (matching the current `bugReportSchema.screenshot` limit) and a soft per-user **20 MB total quota** rejected at submit with a 413.
- **EXIF stripping** in the browser via canvas re-encode before upload — prevents inadvertent GPS leak.
- **PII warning** in the form copy: "Your screenshot may contain personal data. Crop it before uploading if unsure."
- **Risk acknowledged in §13** — DB bloat is the obvious downside; v2 moves blobs to object storage.

## 7. Abuse & Safety

- Rate-limit via `src/lib/rate-limit.ts`: `feedback:submit:${user.id}` → 5 per rolling hour. Admin endpoints rate-limited too (`feedback:admin:${user.id}`, 60/min).
- Description and subject are **plain text** — no HTML, no Markdown rendering on display in the admin inbox (use `<pre>` or a plain `<div>` with `whitespace-pre-wrap`). When publishing to GitHub we apply the same backtick-escape sanitization as the current bugreport route.
- Length caps enforced in Zod and at the DB level (`@db.VarChar(200)` for subject).
- **Auto-archive job** in `src/lib/jobs/`: daily pg-boss job marks `RESOLVED` items older than 180 days as `ARCHIVED`, and deletes `ARCHIVED` items older than 365 days. Configurable via `AppSettings`.
- Inbox-size soft cap (e.g., 10 000 OPEN rows) surfaces a banner in the admin UI prompting cleanup.

## 8. Migration

- Additive Prisma migration only (new enum, new table). No existing data touched.
- `/api/bugreport` route stays for **two release cycles**, internally calls the new feedback pipeline, and emits a `Deprecation` response header pointing to `/api/feedback`.
- `/api/bugreport/status` keeps responding for legacy clients but its `configured` field now means "feedback works" (always `true` for authenticated users), with `hasGithub` exposed separately.
- No data backfill required.

## 9. Notifications

- On a successful `POST /api/feedback`, dispatch through `src/lib/notifications/dispatcher.ts` to whichever admin channels are configured (email-first for v1; Telegram/ntfy/web-push fall out for free since they share the dispatcher).
- Payload: category, subject, submitter username, deep link `/admin#feedback?id=...`. **No description body** in the notification — keeps PII out of email/push transports.
- `notifiedEmail = true` after a successful send so retries don't double-fire.
- If no channel is configured, dispatch is a no-op (logged as an info annotation, not a warning).

## 10. i18n

New translation namespace `feedback.*` in `messages/en.json` and `messages/de.json`:
- Category names (`feedback.category.bug` etc.), status names, form labels, admin-inbox column headers, action button labels, empty states, toast/confirmation copy, PII warning text, deprecation banner on legacy bugreport endpoint.
- Existing `bugreport.*` keys stay until the route is removed; new UI does not depend on them.

## 11. GitHub Publish

- Refactor the GitHub-issue creation in `src/app/api/bugreport/route.ts` into `src/lib/feedback/publish-github.ts` — pure function `publishToGithub(feedback): Promise<{ issueNumber, issueUrl }>`. Reused by both the deprecated bugreport route (transparently) and the new `POST /api/admin/feedback/:id/github`.
- Idempotency: if `gitHubIssueUrl` is already set on the feedback row, return 409 with the existing URL.
- Admin can append optional context via a textarea in the publish dialog; this is prepended to the issue body and **not** stored on the feedback row.

## 12. Nyquist Validation

Acceptance scenarios that must pass before sign-off:
- Submit while logged out → 401.
- Submit 6 times in an hour → 6th returns 429 with rate-limit headers.
- Screenshot > 5 MB → 413, no DB row created.
- Cumulative user quota > 20 MB → 413 with quota-specific error code.
- Non-admin hits `/api/admin/feedback*` → 403.
- Publish-to-GitHub round-trip: feedback row gains `gitHubIssueUrl`, repeat call returns 409.
- Auto-archive job marks correct rows after fast-forwarding clock in test.
- Notification dispatch is silent when no channel configured (info event, not warning).
- Plain-text rendering verified — submitting `<script>alert(1)</script>` displays escaped in admin UI.
- Wide Event payload includes `action.name=feedback.submit`, `meta.category`, `meta.has_screenshot`.

## 13. Risks

- **DB bloat from base64 screenshots.** Mitigation: per-item + per-user quotas now, object storage migration (S3/MinIO/Coolify volume) tracked as a follow-up. Schema is forward-compatible — `screenshotBase64` becomes nullable alongside a future `screenshotKey` column.
- **Email transport coupling.** If the dispatcher fails, submission must still succeed; notifications are fire-and-forget after the DB row commits.
- **Admin-inbox UX scaling** past a few hundred items needs server-side filtering (already in the API spec).

## 14. Out of Scope

- User-to-user comment threads on feedback items.
- Voting / upvoting feedback.
- Public read-only feedback board.
- Anonymous (logged-out) submissions — schema-ready, intentionally not enabled in v1.
- Importing existing GitHub issues back into the inbox.

## 15. Effort

**M** — one Prisma migration, ~6 new API routes (most thin), one form refactor, one new admin section, refactor of existing GitHub call into a helper, dispatcher hookup, one pg-boss job, ~30 i18n keys × 2 locales.
