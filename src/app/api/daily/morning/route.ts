/**
 * GET /api/daily/morning
 *
 * The morning read on `/`: one sentence chosen by fixed rules from the day's
 * own readings, and up to two cards (last night, what is different today).
 * The third card is the digest's rail, read from `/api/daily/digest`.
 *
 * Data, not AI: no module gate and no AI gate, no provider on the path, and
 * nothing here reaches a model. Same scope as the digest: the record's own
 * read, cookie or Bearer, `userId` narrowed from the resolved session.
 */
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { NO_STORE_BUT_BFCACHE } from "@/lib/http/cache-headers";
import { loadDailyMorning } from "@/lib/daily/morning-load";
import { nativeRequestLocale } from "@/lib/i18n/server-locale";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async (request: Request) => {
  const { user, authMethod } = await requireRecordAuth("read", "record");
  // The app's own language words the sentence; a browser's cookie does that.
  const locale = nativeRequestLocale(authMethod, request);
  const morning = await loadDailyMorning(
    user,
    new Date(),
    locale ? { locale } : {},
  );
  const response = apiSuccess(morning);
  response.headers.set("Cache-Control", NO_STORE_BUT_BFCACHE);
  return response;
});
