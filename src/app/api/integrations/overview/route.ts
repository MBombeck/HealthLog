/**
 * `GET /api/integrations/overview`: one row per data source and delivery
 * channel, with the status word, its reason and when it last worked, resolved
 * on the server (`src/lib/integrations/overview.ts`). The Settings →
 * Integrations list renders it as it comes; a native client mirrors it.
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { loadIntegrationOverview } from "@/lib/integrations/overview-load";
import { annotate } from "@/lib/logging/context";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "integrations.overview" } });
  return apiSuccess(await loadIntegrationOverview(user.id));
});
