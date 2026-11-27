/**
 * GET /api/daily/digest
 *
 * The read seam for the unified daily-value system (P3). Returns the
 * `DailyDigest` DTO the Today surface, the daily push, and a future iOS widget
 * all consume — assembled by `loadDailyDigest` from ALREADY-CACHED data (the
 * nightly briefing lifted read-only from `User.insightsCachedTextEncrypted`, the
 * dashboard-snapshot health score / meds-today / sleep freshness) plus two
 * light deterministic reads (broken integrations, overdue Vorsorge). No
 * provider call is reachable from this path, and nothing warms on mount.
 *
 * Cookie OR Bearer auth via `requireAuth()`; `userId` is narrowed from the
 * resolved session — never a body field. No module gate and no AI gate: the
 * digest is data (score, doses, syncs, checkups, the day's markers). Its AI
 * parts, the briefing lead, the reaction line and the Coach check-in, are
 * served only while their capabilities are available, and the `ai` block says
 * which. The rail's data-tile inputs inherit their own module gates via the
 * snapshot builder.
 */
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { loadDailyDigest } from "@/lib/daily/load-digest";
import { nativeRequestLocale } from "@/lib/i18n/server-locale";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async (request: Request) => {
  // The record's Today hero. Same family as the dashboard snapshot and
  // admitted on the same argument: an aggregate over the record's own data,
  // assembled from already-cached values with no provider on the path. The
  // AI parts resolve against the RECORD, so a delegate sees the owner's
  // capabilities, never their own. Re-examine with the snapshot when
  // per-module scope lands; a digest is a summary of several modules at once.
  const { user, authMethod, grantId } = await requireRecordAuth(
    "read",
    "record",
  );

  // #176 — the app's own language (Accept-Language) words the texts the
  // server writes itself; a browser's cookie already does that.
  const locale = nativeRequestLocale(authMethod, request);
  // The admin question is asked only where it can be answered: a browser
  // session on the admin's own record (the answers are cookie-only routes).
  const adminAsks = authMethod === "cookie" && grantId === null;
  const digest = await loadDailyDigest(user, new Date(), {
    ...(locale ? { locale } : {}),
    adminAsks,
  });

  return apiSuccess(digest);
});
