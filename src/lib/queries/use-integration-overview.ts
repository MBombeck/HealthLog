"use client";

import { useQuery } from "@tanstack/react-query";

import { apiGet } from "@/lib/api/api-fetch";
import type { IntegrationOverview } from "@/lib/integrations/overview";
import { queryKeys } from "@/lib/query-keys";

/**
 * `GET /api/integrations/overview`, the one read of every source's and
 * channel's state. The Integrations list, its sheets and the channel cards'
 * status chips share this cache entry, so a page loads the facts once and
 * no surface derives a status of its own.
 */
export function useIntegrationOverview(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.integrationsOverview(),
    queryFn: () => apiGet<IntegrationOverview>("/api/integrations/overview"),
    enabled,
    refetchOnWindowFocus: true,
  });
}
