/**
 * `POST /api/import/health-connect-export` — upload an Android Health Connect
 * export ZIP for background import (v1.42, #972). Outside the proxy matcher
 * like the Apple Health upload (`src/lib/http/proxy-bypass-routes.ts`), so the
 * body is streamed to disk after authentication instead of being buffered.
 *
 * Contract stub: authenticates as the finished route will, then answers 501.
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { notImplemented } from "@/lib/http/not-implemented";

export const POST = apiHandler(async () => {
  await requireAuth();
  return notImplemented();
});
