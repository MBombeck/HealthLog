/**
 * `GET /api/sync/changes` — multi-domain delta feed (v1.7.0).
 *
 * The incremental catch-up feed for paired clients. After the first-pair
 * backfill (which uses the batch endpoints), the client drains this feed
 * to pick up server-side changes — including deletions, which surface as
 * tombstones because the user-facing DELETE routes on every served
 * domain now soft-delete (set `deletedAt` + bump `syncVersion`) rather
 * than hard-delete.
 *
 * Domains served: `measurements`, `mood`, `intakes`, `cycleDays`,
 * `cycles` (the last two added v1.15.0; `cycleDays` tombstones key on
 * `externalId` when present else `id`, `cycles` on `id`). The iOS consumer
 * is measurements-only this cycle (iOS-coord
 * `v1.7.0-ios-offline-sync-answers.md` §7.1); mood + intakes are
 * forward-prep so the contract is complete + tested before the
 * multi-domain consumer lands.
 *
 * Contract:
 *   - One opaque multi-domain keyset cursor wrapping a per-domain
 *     `(updatedAt, id)` watermark; the client treats it as fully opaque
 *     (echo, never parse — iOS-coord §7.6). `limit` default 200, hard
 *     cap 500, applied PER DOMAIN.
 *   - Each domain block carries `tombstones` (soft-deleted rows) AND
 *     `upserts` (live rows). The client MUST apply tombstones before
 *     upserts within each domain to avoid resurrecting a row whose
 *     delete and a later re-insert both fall in the page.
 *   - Tombstone identity per the iOS §7.3 table: measurements key on
 *     `externalId` (the cross-device key); mood + intakes key on the
 *     server `id` (the client mirrors those by server id).
 *   - `hasMore` is true when ANY served domain still has rows past its
 *     page; the next `cursor` advances every domain that returned rows.
 *     When `hasMore` is false the client is caught up as of `serverNow`.
 *   - `cursorExpired: true` when ANY domain watermark predates the
 *     tombstone-retention horizon — the client drops its cursor and does
 *     a clean initial sync (a deletion older than retention may have
 *     been pruned, so an incremental delta could silently miss it) — or
 *     when the cursor was issued before the account's `syncResetAt` (a
 *     backup restore or a delete-all-data since, see the schema note).
 *   - `syncVersion` is echoed per row so the client can keep its mirror's
 *     version monotonic.
 *   - The `cycleDays` / `cycles` blocks are MODULE-GATED: an account with
 *     cycle tracking off gets both blocks empty (never a 403 — see the
 *     gate note in the handler) and their cursor watermarks untouched.
 *
 * `apiHandler` + `requireAuth` (cookie OR Bearer; iOS uses Bearer).
 * Read-only — no idempotency, no write side-effect (unlike the legacy
 * `/api/sync/state` checkpoint bump). The cursor is owned by the client.
 * The pull itself lives in `src/lib/sync/changes/`.
 */
import type { NextRequest } from "next/server";
import { z } from "zod/v4";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  apiValidationError,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { checkRateLimit } from "@/lib/rate-limit";
import { pullSyncChanges } from "@/lib/sync/changes/pull";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

const querySchema = z.object({
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
});

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  // Pull is cheap + idempotent; a generous per-user bucket caps a runaway
  // drain loop without throttling normal foreground catch-up.
  const rl = await checkRateLimit(`sync:changes:${user.id}`, 120, 60 * 1000);
  if (!rl.allowed) {
    return apiError("Too many sync requests. Please retry later.", 429);
  }

  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    cursor: url.searchParams.get("cursor") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
  });
  if (!parsed.success) {
    return apiValidationError(
      "Invalid sync query",
      sanitiseZodIssues(parsed.error.issues),
      422,
    );
  }

  return apiSuccess(
    await pullSyncChanges({
      userId: user.id,
      token: parsed.data.cursor,
      limit: parsed.data.limit ?? DEFAULT_LIMIT,
      serverNow: new Date(),
    }),
  );
});
