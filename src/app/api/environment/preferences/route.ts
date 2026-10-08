/**
 * `PATCH /api/environment/preferences` — the caller's environment switches,
 * today `airQualityEnabled` (v1.42, #615). Module-gated like the rest of the
 * environment surface.
 *
 * Contract stub: authenticates as the finished route will, then answers 501.
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { notImplemented } from "@/lib/http/not-implemented";
import { requireModuleEnabled } from "@/lib/modules/gate";

export const PATCH = apiHandler(async () => {
  const { user } = await requireAuth();
  const gate = await requireModuleEnabled(user.id, "environment");
  if (!gate.enabled) return gate.response;
  return notImplemented();
});
