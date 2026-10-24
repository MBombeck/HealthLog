"use client";

import { useQuery } from "@tanstack/react-query";

import { apiGet } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";
import type { DocumentUsageDto } from "@/lib/validations/inbound-documents";

/**
 * The vault's usage read (`GET /api/documents/inbound/usage`): limits, usage,
 * filter choices, index coverage and the Recently deleted count. One
 * definition for every reader, so the shared key never meets a second
 * `queryFn` shape.
 */
export function useDocumentUsage(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.inboundDocumentUsage(),
    enabled,
    queryFn: () => apiGet<DocumentUsageDto>("/api/documents/inbound/usage"),
  });
}
