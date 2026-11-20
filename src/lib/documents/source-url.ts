/**
 * The way back from an imported copy to the original in the archive (#1394).
 *
 * A document imported from Paperless-ngx or Papra carries its source key
 * (`sourceSystem`, `sourceId`, optionally `sourceInstance`). The link to the
 * original is built here, on the server, from the person's own connection to
 * that archive, never from anything an upload or a request sent:
 *
 *   - Paperless-ngx: `{baseUrl}/documents/{id}/details`
 *   - Papra:         `{baseUrl}/organizations/{organizationId}/documents/{id}`
 *
 * It exists only when
 *   - the document's system has a connection of the same system,
 *   - the id has that system's own shape (`PAPERLESS_ID` / `PAPRA_ID`), so it
 *     is one path segment and nothing more,
 *   - the stored instance is the connection's origin, or none is stored (one
 *     connection per system, so it is that archive),
 *   - and the connection's base URL still passes the operator's
 *     `DOCUMENT_SOURCE_ORIGINS` list.
 *
 * Whatever the source key holds can therefore only pick a document page on
 * the person's own connected archive. The link is the owner's alone: callers
 * resolve it only when the caller acts on their own record, and every other
 * view (a delegate, a guardian, a share link, MCP) gets `null`, so the archive
 * address never leaves into a view that is not the owner's.
 *
 * For Papra the connection's organization is used. A copy imported from
 * another organization opens Papra's not-found page; the source key cannot
 * tell the two apart.
 */
import type { InboundDocumentDto } from "@/lib/validations/inbound-documents";

import { listConnections } from "./sources/connections";
import {
  configuredDocumentSourceOrigins,
  evaluateSourceBaseUrl,
} from "./sources/origins";
import {
  isSourceDocumentId,
  PAPRA_ORG_ID,
  type DocumentPickerSystem,
} from "./sources/types";

/** The parts of a document row the link is built from. */
export interface SourceKeyFields {
  sourceSystem: string | null;
  sourceId: string | null;
  sourceInstance: string | null;
}

/** The parts of a stored connection the link is built from. Never the token. */
export interface SourceLinkConnection {
  system: string;
  baseUrl: string;
  organizationId: string | null;
}

function originOf(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

/**
 * The link to a document's original, or null when any check fails. Pure:
 * `connections` are the owner's stored connections, `origins` the operator's
 * list.
 */
export function buildSourceUrl(
  doc: SourceKeyFields,
  connections: readonly SourceLinkConnection[],
  origins: ReadonlySet<string> = configuredDocumentSourceOrigins(),
): string | null {
  const system = doc.sourceSystem;
  const id = doc.sourceId;
  if ((system !== "PAPERLESS" && system !== "PAPRA") || !id) return null;
  if (!isSourceDocumentId(system as DocumentPickerSystem, id)) return null;
  const connection = connections.find((c) => c.system === system);
  if (!connection) return null;

  const verdict = evaluateSourceBaseUrl(connection.baseUrl, origins);
  if (!verdict.ok) return null;
  if (doc.sourceInstance !== null) {
    if (originOf(doc.sourceInstance) !== verdict.origin) return null;
  }

  let path: string;
  if (system === "PAPERLESS") {
    path = `/documents/${encodeURIComponent(id)}/details`;
  } else {
    const org = connection.organizationId;
    if (!org || !PAPRA_ORG_ID.test(org)) return null;
    path = `/organizations/${encodeURIComponent(org)}/documents/${encodeURIComponent(id)}`;
  }

  let url: URL;
  try {
    // `verdict.baseUrl` is origin + path with trailing slashes trimmed, so a
    // base served under a path (`/paperless`) keeps it.
    url = new URL(`${verdict.baseUrl}${path}`);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.origin !== verdict.origin) return null;
  return url.href;
}

/** The parts of a record-auth context the owner check reads. */
export interface SourceUrlCaller {
  user: { id: string };
  actor: { id: string };
  grantId: string | null;
}

/** Does the caller act on their own record (no grant, no switched profile)? */
export function actsAsOwner(auth: SourceUrlCaller): boolean {
  return auth.grantId === null && auth.actor.id === auth.user.id;
}

/**
 * Fill `sourceUrl` on DTOs the owner is about to receive. Reads the owner's
 * connections once, and only when a document could carry a link at all. For
 * anyone who is not the owner the DTOs keep `sourceUrl: null` untouched.
 */
export async function attachOwnerSourceUrls<T extends InboundDocumentDto>(
  auth: SourceUrlCaller,
  pairs: ReadonlyArray<{ dto: T; row: SourceKeyFields }>,
): Promise<void> {
  if (!actsAsOwner(auth)) return;
  const candidates = pairs.filter(
    ({ row }) =>
      row.sourceSystem === "PAPERLESS" || row.sourceSystem === "PAPRA",
  );
  if (candidates.length === 0) return;
  const origins = configuredDocumentSourceOrigins();
  if (origins.size === 0) return;
  const connections = await listConnections(auth.user.id);
  if (connections.length === 0) return;
  for (const { dto, row } of candidates) {
    dto.sourceUrl = buildSourceUrl(row, connections, origins);
  }
}
