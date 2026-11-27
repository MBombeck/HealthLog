"use client";

/**
 * The document picker's availability for the person on this screen (#1038).
 *
 * Reads `GET /api/documents/sources` only in the person's own record: a
 * delegate or guardian never asks (the route would refuse them anyway), so
 * the import buttons and the settings card render nothing for them.
 * `connected` is the list of systems with a usable connection (the documents
 * module on, the operator's list set, the origin still on it), in a stable
 * order; the import buttons read only that.
 */
import { useQuery } from "@tanstack/react-query";

import { useAuth } from "@/hooks/use-auth";
import {
  useRecordCapabilities,
  holdsOwnerRights,
} from "@/hooks/use-record-capabilities";
import { apiGet } from "@/lib/api/api-fetch";
import type {
  DocumentPickerSystem,
  DocumentSourcesStatusDto,
} from "@/lib/documents/sources/types";
import { queryKeys } from "@/lib/query-keys";

export function useDocumentSourcesStatus() {
  const { user } = useAuth();
  const caps = useRecordCapabilities();
  // The status read touches only the person's own rows and never the
  // network, so it runs in one's own record whatever the module says: a
  // connection stored before Documents was switched off, or before the
  // operator removed the list, must stay visible so it can be deleted.
  const ownRecord =
    user !== null &&
    user !== undefined &&
    holdsOwnerRights(caps) &&
    caps.canManageDomain("documents");
  const eligible = ownRecord && user?.modules?.inboundDocuments === true;

  const query = useQuery({
    queryKey: queryKeys.documentSourcesStatus(),
    enabled: ownRecord,
    queryFn: () => apiGet<DocumentSourcesStatusDto>("/api/documents/sources"),
    staleTime: 60_000,
  });

  const connected: DocumentPickerSystem[] =
    eligible && query.data?.available
      ? query.data.connections
          .filter((c) => c.originAllowed)
          .map((c) => c.system)
      : [];

  return { ownRecord, eligible, query, connected };
}

/** Display name of a system; product names, not translated. */
export function systemName(system: DocumentPickerSystem): string {
  return system === "PAPERLESS" ? "Paperless-ngx" : "Papra";
}
